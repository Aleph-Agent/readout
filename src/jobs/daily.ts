import {
  appendEvents,
  eventId,
  readEvents,
  readLiveState,
  readMeta,
  readSnapshot,
  readWindow,
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

  const existing = readEvents(month);
  const lastDetection = new Map<string, string>();
  for (const event of existing) {
    if (event.kind !== 'fork-spike') continue;
    if (event.confidence !== 'detected' && event.confidence !== 'confirmed') continue;
    const date = event.detectedAt.slice(0, 10);
    const previous = lastDetection.get(event.repo);
    if (previous === undefined || previous < date) lastDetection.set(event.repo, date);
  }

  const seen = new Set(existing.map((event) => event.id));
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

  if (events.length > 0) appendEvents(month, events);

  const previousMeta = readMeta();
  const meta: MetaRecord = {
    ...previousMeta,
    lastRunAt: nowIso,
    lastSuccessfulRunAt: errors.length > 0 ? previousMeta.lastSuccessfulRunAt : nowIso,
    job: 'daily',
    partial: errors.length > 0,
    reposChecked: snapshot.length,
    eventsDetected: events.length,
    collectorsErrored: errors,
  };

  writeMeta(meta);
  return meta;
}
