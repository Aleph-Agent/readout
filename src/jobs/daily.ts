import { collectIssues } from '../collectors/issues.ts';
import { collectManifests } from '../collectors/manifests.ts';
import { lastDetectionByRepo } from '../lib/confidence.ts';
import { createGitHubClient, type GitHubClient } from '../lib/github.ts';
import {
  appendEvents,
  eventId,
  readAllEvents,
  readLiveState,
  readManifests,
  readMeta,
  readSnapshot,
  readWatchlist,
  readWindow,
  writeManifests,
  writeMeta,
  writeSnapshot,
} from '../lib/ledger.ts';
import { utcDate, utcMonth } from '../lib/paths.ts';
import {
  classifySpike,
  DEFAULT_THRESHOLDS,
  roundMultiplier,
  type DailyForkCount,
  type SpikeThresholds,
} from '../lib/spikes.ts';
import { classifyPeers, type PeerObservation } from '../lib/peers.ts';
import { windowAnchor } from '../lib/window.ts';
import type { EventRecord } from '../types/events.ts';
import type { HistorySnapshotRow } from '../types/history.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * The daily job: write the canonical snapshot, then classify spikes against it.
 *
 * History is written once a day rather than once a pulse. Six snapshots daily
 * would multiply repository growth sixfold and buy nothing — a baseline only
 * needs daily resolution.
 */

export interface DailyOptions {
  now?: Date;
  thresholds?: SpikeThresholds;
  /** How far back to read history when building baselines. */
  historyDays?: number;
  token?: string;
  /** Pre-built client, for tests that never reach the network. */
  client?: GitHubClient;
  /**
   * Skip the two network collectors. Snapshot and spike classification read
   * only what the pulses already collected, so they still run.
   */
  offline?: boolean;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

function readHistoryWindow(today: Date, days: number): Map<string, DailyForkCount[]> {
  const byRepo = new Map<string, DailyForkCount[]>();

  for (let back = 1; back <= days; back += 1) {
    const day = new Date(today.getTime() - back * 86_400_000);
    for (const row of readSnapshot(utcDate(day))) {
      const list = byRepo.get(row.id);
      if (list) list.push({ date: row.date, forks: row.forks });
      else byRepo.set(row.id, [{ date: row.date, forks: row.forks }]);
    }
  }

  return byRepo;
}

export async function runDaily(options: DailyOptions = {}): Promise<MetaRecord> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const today = utcDate(now);
  const month = utcMonth(now);
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;

  const state = readLiveState();
  const errors: string[] = [];

  // 1. Snapshot. Immutable once written, so a re-run on the same day is a
  //    no-op rather than a rewrite of the audit trail.
  const snapshot: HistorySnapshotRow[] = state
    .filter((row) => row.active)
    .map((row) => ({
      id: row.id,
      date: today,
      forks: row.forks,
      stars: row.stars,
      openIssues: row.openIssues,
    }));

  try {
    writeSnapshot(today, snapshot);
  } catch (error) {
    errors.push(`snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. Classify. Baselines come from history, the near edge from live state,
  //    and the far edge from the rolling window.
  const history = readHistoryWindow(now, options.historyDays ?? thresholds.baselineWindowDays);
  const windows = new Map(readWindow().map((row) => [row.id, row.samples]));

  // Read the whole ledger, not this month's file. Scoped to one month, a spike
  // detected on the 31st would drop back to `detected` on the 1st and
  // confirmation would reset at every month boundary.
  const allEvents = readAllEvents();
  const lastDetection = lastDetectionByRepo(allEvents);
  const seen = new Set(allEvents.map((event) => event.id));
  const events: EventRecord[] = [];

  for (const row of state) {
    if (!row.active) continue;

    const anchor = windowAnchor(windows.get(row.id) ?? [], now.getTime());

    const verdict = classifySpike(
      {
        repo: row.id,
        history: history.get(row.id) ?? [],
        currentForks: row.forks,
        observedAt: nowIso,
        windowStartForks: anchor?.forks ?? null,
        windowStartAt: anchor?.at ?? null,
        previousDetectionDate: lastDetection.get(row.id) ?? null,
        today,
      },
      thresholds,
    );

    // `forming` and `quiet` are correct outcomes, not events. A quiet
    // instrument reporting nothing detected is working; manufacturing an event
    // to fill the feed is how a credibility argument gets spent.
    if (verdict.state !== 'detected' && verdict.state !== 'confirmed') continue;

    const id = eventId('fork-spike', row.id, today);
    if (seen.has(id)) continue;
    seen.add(id);

    events.push({
      id,
      kind: 'fork-spike',
      repo: row.id,
      detectedAt: nowIso,
      confidence: verdict.state,
      // Only a confirmed spike is worth prose. A detection that evaporates
      // tomorrow should never have had a sentence written about it.
      summaryState: verdict.state === 'confirmed' ? 'pending' : 'skipped',
      summary: null,
      evidenceUrl: `https://github.com/${row.id}`,
      metrics: {
        forksAdded: verdict.delta,
        observationHours: verdict.windowHours === null ? null : Math.round(verdict.windowHours),
        baselinePerDay:
          verdict.baselinePerDay === null ? null : roundMultiplier(verdict.baselinePerDay),
        baselineDays: verdict.baselineDays,
        multiplier:
          verdict.displayMultiplier === null ? null : roundMultiplier(verdict.displayMultiplier),
        multiplierCapped: verdict.multiplierCapped ? 'yes' : 'no',
        totalForks: row.forks,
      },
      supersedes: null,
    });
  }

  // 3. Demand and dependencies. Both are daily-only: manifests barely change,
  //    and polling them on the pulse would spend 2,000 requests watching files
  //    sit still. Budget here is ~80 issue requests plus one manifest request
  //    per active repository, well inside the thousand the daily job allows.
  let requestsConsumed = 0;

  if (options.offline !== true) {
    const client =
      options.client ??
      createGitHubClient({ token: options.token ?? process.env['GITHUB_PAT'] ?? '' });

    const seen = new Set([...allEvents.map((event) => event.id), ...events.map((e) => e.id)]);

    const previousTerms = new Set(
      allEvents
        .filter(
          (event) =>
            event.kind === 'demand-cluster' &&
            typeof event.metrics['term'] === 'string' &&
            event.detectedAt.slice(0, 10) >= utcDate(new Date(now.getTime() - 2 * 86_400_000)),
        )
        .map((event) => event.metrics['term'] as string),
    );

    try {
      const demand = await collectIssues(client, state, { now: nowIso, today, previousTerms, seen });
      for (const event of demand.events) {
        events.push(event);
        seen.add(event.id);
      }
      errors.push(...demand.errors);
    } catch (error) {
      errors.push(`issues: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const manifests = await collectManifests(
        client,
        state,
        new Map(readManifests().map((row) => [row.id, row])),
        { now: nowIso, today, seen },
      );
      writeManifests(manifests.rows);
      for (const event of manifests.events) {
        events.push(event);
        seen.add(event.id);
      }
      errors.push(...manifests.errors);
    } catch (error) {
      errors.push(`manifests: ${error instanceof Error ? error.message : String(error)}`);
    }

    requestsConsumed = client.stats().consumed;
  }

  // 2b. Peer-relative outliers. The self-relative detector above says nothing
  //     for fourteen days; this one needs a single filled window, because it
  //     compares a repository against the rest of its category on the same day
  //     rather than against its own past. Separate claim, separate event kind.
  const categories = new Map(readWatchlist().map((entry) => [entry.id, entry.category as string]));
  const lastOutlier = lastDetectionByRepo(allEvents, 'fork-outlier');

  const observations: PeerObservation[] = [];
  for (const row of state) {
    if (!row.active) continue;
    const category = categories.get(row.id);
    if (category === undefined) continue;

    const anchor = windowAnchor(windows.get(row.id) ?? [], now.getTime());
    if (anchor === null) {
      observations.push({ id: row.id, category, delta: 0, windowHours: 0 });
      continue;
    }

    observations.push({
      id: row.id,
      category,
      delta: row.forks - anchor.forks,
      windowHours: (now.getTime() - Date.parse(anchor.at)) / 3_600_000,
    });
  }

  for (const peer of classifyPeers(observations)) {
    if (peer.state !== 'outlier') continue;

    const id = eventId('fork-outlier', peer.id, today);
    if (seen.has(id)) continue;
    seen.add(id);

    const previous = lastOutlier.get(peer.id);
    const age = previous === undefined ? null : daysBetween(previous, today);
    const confirmed = age !== null && age >= 1 && age <= 2;

    events.push({
      id,
      kind: 'fork-outlier',
      repo: peer.id,
      detectedAt: nowIso,
      confidence: confirmed ? 'confirmed' : 'detected',
      summaryState: confirmed ? 'pending' : 'skipped',
      summary: null,
      evidenceUrl: `https://github.com/${peer.id}`,
      metrics: {
        forksAdded: peer.delta,
        observationHours: Math.round(peer.windowHours),
        category: peer.category,
        categoryMedian: peer.median,
        peers: peer.peers,
        rankInCategory: peer.rank,
        ratioToMedian: peer.displayRatio === null ? null : roundMultiplier(peer.displayRatio),
        ratioCapped: peer.ratioCapped ? 'yes' : 'no',
        totalForks: state.find((r) => r.id === peer.id)?.forks ?? null,
      },
      supersedes: null,
    });
  }

  if (events.length > 0) appendEvents(month, events);

  const previousMeta = readMeta();
  const meta: MetaRecord = {
    ...previousMeta,
    lastRunAt: nowIso,
    lastSuccessfulRunAt: errors.length > 0 ? previousMeta.lastSuccessfulRunAt : nowIso,
    job: 'daily',
    partial: errors.length > 0,
    requestsConsumed,
    reposChecked: snapshot.length,
    eventsDetected: events.length,
    collectorsErrored: errors,
  };

  writeMeta(meta);
  return meta;
}
