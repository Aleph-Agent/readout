import { collectBase } from '../collectors/base.ts';
import { collectReleases } from '../collectors/releases.ts';
import { createGitHubClient, type GitHubClient } from '../lib/github.ts';
import {
  appendEvents,
  readActiveWatchlist,
  readEvents,
  readLiveState,
  readMeta,
  readWindow,
  writeLiveState,
  writeMeta,
  writeWindow,
} from '../lib/ledger.ts';
import { utcDate, utcMonth } from '../lib/paths.ts';
import { recordSample } from '../lib/window.ts';
import type { MetaRecord } from '../types/meta.ts';
import type { LiveStateRow } from '../types/state.ts';
import type { WindowRow } from '../types/window.ts';

/**
 * The 4-hourly pulse: repository base, then releases.
 *
 * Manifests, the daily snapshot, and lineage are not here on purpose. Polling
 * dependency manifests six times a day would spend 2,000 requests to observe
 * files that barely change.
 */

export interface PulseOptions {
  token?: string;
  /** Pre-built client, for tests that never touch the network. */
  client?: GitHubClient;
  now?: Date;
  /** Cap the watchlist. Used by the dry run. */
  limit?: number;
}

export async function runPulse(options: PulseOptions = {}): Promise<MetaRecord> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const today = utcDate(now);

  const client =
    options.client ??
    createGitHubClient({ token: options.token ?? process.env['GITHUB_PAT'] ?? '' });

  const watchlist = readActiveWatchlist();
  const entries = options.limit === undefined ? watchlist : watchlist.slice(0, options.limit);

  const previousRows = readLiveState();
  const previousState = new Map(previousRows.map((row) => [row.id, row]));

  const base = await collectBase(client, entries, previousState);

  // A repository with no prior row has no release history to compare against,
  // so its current tag is a starting point rather than news.
  const firstObservation = new Set(
    base.rows.filter((row) => !previousState.has(row.id)).map((row) => row.id),
  );

  const month = utcMonth(now);
  const alreadyReleasedToday = new Set(
    readEvents(month)
      .filter((event) => event.kind === 'release' && event.detectedAt.slice(0, 10) === today)
      .map((event) => event.repo),
  );

  const releases = await collectReleases(client, base.rows, {
    now: nowIso,
    today,
    alreadyReleasedToday,
    firstObservation,
  });

  const rows: LiveStateRow[] = base.rows.map((row) => {
    const update = releases.updates.get(row.id);
    return update ? { ...row, ...update } : row;
  });

  writeLiveState(rows);

  const windowRows = new Map(readWindow().map((row) => [row.id, row]));
  const nextWindow: WindowRow[] = [];
  for (const row of rows) {
    if (!row.active) continue;
    const existing = windowRows.get(row.id)?.samples ?? [];
    nextWindow.push({ id: row.id, samples: recordSample(existing, nowIso, row.forks) });
  }
  writeWindow(nextWindow);

  if (releases.events.length > 0) appendEvents(month, releases.events);

  const stats = client.stats();
  const errors = [...base.errors, ...releases.errors];
  const stoppedEarly = base.stoppedEarly || releases.stoppedEarly;

  const previousMeta = readMeta();
  const meta: MetaRecord = {
    ...previousMeta,
    lastRunAt: nowIso,
    // Stopping on budget is a clean exit, but it is not a full reading, and the
    // header must not present it as one.
    lastSuccessfulRunAt: stoppedEarly ? previousMeta.lastSuccessfulRunAt : nowIso,
    job: 'pulse',
    partial: stoppedEarly || errors.length > 0,
    requestsConsumed: stats.consumed,
    rateLimitRemaining: stats.rateLimitRemaining,
    reposChecked: entries.length,
    reposUnchanged: stats.unchanged,
    eventsDetected: releases.events.length,
    collectorsErrored: errors,
  };

  writeMeta(meta);
  return meta;
}
