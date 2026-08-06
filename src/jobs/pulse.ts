import { collectBase } from '../collectors/base.ts';
import { collectLicences } from '../collectors/licences.ts';
import { collectReleases } from '../collectors/releases.ts';
import { createGitHubClient, type GitHubClient } from '../lib/github.ts';
import {
  appendEvents,
  readActiveWatchlist,
  readEvents,
  readLiveState,
  readMeta,
  readWatchlist,
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

  // Only repositories this run actually collected. base.rows also carries
  // forward every previously known row, and iterating those would make
  // --limit=20 quietly hit four hundred release endpoints.
  const scope = new Set(entries.map((entry) => entry.id));
  const collectedNow = base.rows.filter((row) => scope.has(row.id));

  const releases = await collectReleases(client, collectedNow, {
    now: nowIso,
    today,
    alreadyReleasedToday,
    firstObservation,
  });

  // Rows for repositories no longer on the watchlist are dropped. Inactive
  // entries keep theirs — the watchlist still lists them, which is the record
  // that they were once watched.
  const known = new Set(readWatchlist().map((entry) => entry.id));

  // Full active list, not `entries` — under --limit the slice says nothing
  // about whether the repositories outside it are still watched.
  const watched = new Set(watchlist.map((entry) => entry.id));

  const rows: LiveStateRow[] = base.rows
    .filter((row) => known.has(row.id))
    .map((row) => {
      const update = releases.updates.get(row.id);
      const next = update ? { ...row, ...update } : row;

      // Retiring a repository on the watchlist has to reach its state row.
      // Otherwise the last reading is carried forward with `active` still true
      // and the repository goes on being drawn on the strip, sampled into the
      // fork window, snapshotted daily and counted in the peer median — on a
      // number that stopped moving the day it was retired.
      return next.active && !watched.has(row.id) ? { ...next, active: false } : next;
    });

  writeLiveState(rows);

  // Licence and archival changes, diffed against the previous pulse. Costs no
  // requests: both fields arrive in the repository payload already fetched, and
  // both were discarded until now. They are also the only two signals here that
  // need no threshold and cannot produce a false positive.
  const fieldChanges = collectLicences(rows, previousState, {
    now: nowIso,
    today,
    seen: new Set(readEvents(month).map((event) => event.id)),
  });
  if (fieldChanges.length > 0) appendEvents(month, fieldChanges);

  const windowRows = new Map(readWindow().map((row) => [row.id, row]));
  const nextWindow: WindowRow[] = [];
  for (const row of rows) {
    if (!row.active) continue;
    const existing = windowRows.get(row.id)?.samples ?? [];
    nextWindow.push({ id: row.id, samples: recordSample(existing, nowIso, row.forks) });
  }
  writeWindow(nextWindow);

  if (releases.events.length > 0) appendEvents(month, releases.events);
  const eventsDetected = releases.events.length + fieldChanges.length;

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
    requestsUnchanged: stats.unchanged,
    eventsDetected,
    collectorsErrored: errors,
  };

  writeMeta(meta);
  return meta;
}
