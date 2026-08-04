import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readActiveWatchlist,
  readAllEvents,
  readLiveState,
  readMeta,
  readSnapshot,
  readSummarised,
  readWatchlist,
  readWindow,
  writeMeta,
} from './lib/ledger.ts';
import { lastDetectionByRepo } from './lib/confidence.ts';
import { DIST_DATA_DIR, utcDate } from './lib/paths.ts';
import {
  classifySpike,
  DEFAULT_THRESHOLDS,
  roundMultiplier,
  type DailyForkCount,
} from './lib/spikes.ts';
import { windowAnchor } from './lib/window.ts';
import {
  LENSES,
  type Disclosure,
  type IndexBundle,
  type LensBundle,
  type LensName,
  type StripMark,
} from './types/bundles.ts';
import type { EventKind, EventRecord } from './types/events.ts';
import type { MetaRecord } from './types/meta.ts';

/**
 * Ledger to static bundles.
 *
 * Reads only what is on disk and makes no network calls, so it can run on a
 * fresh checkout and produce byte-identical output for identical input. That
 * property is what makes the deploy gate possible.
 */

/** A bundle past this size makes the page slow enough to need pagination. */
const MAX_BUNDLE_BYTES = 500 * 1024;

/** Records newer than this go in the primary bundle; older ones are archived. */
const DEFAULT_WINDOW_DAYS = 90;

const PULSE_CADENCE_HOURS = 4;

/**
 * Which event kinds feed which lens.
 *
 * `correction` is absent deliberately: a correction has no lens of its own, it
 * inherits the lens of the claim it replaces. See `groupByLens`.
 */
const LENS_KINDS: Record<LensName, readonly EventKind[]> = {
  ships: ['release'],
  forks: ['fork-spike'],
  demand: ['demand-cluster'],
  stack: ['dependency-shift'],
  lineage: ['lineage'],
};

/** Lenses whose collectors do not exist yet. Prompt 7 activates the first two. */
const PENDING_LENSES = new Set<LensName>(['demand', 'stack', 'lineage']);

export interface BuildResult {
  files: { name: string; bytes: number }[];
  totalBytes: number;
  /** Hash of the content bundles. Excludes volatile run telemetry. */
  bundleHash: string;
  /** False when the hash matched the previous run and deployment can be skipped. */
  deploy: boolean;
}

export interface BuildOptions {
  now?: Date;
  windowDays?: number;
}

function stableJson(value: unknown): string {
  // Sorted keys throughout, so the same data always hashes the same way.
  return `${JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
    const source = inner as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = source[key];
    return sorted;
  })}\n`;
}

/**
 * Corrections supersede the events they correct. Both stay in the ledger — the
 * append-only history is the audit trail — but the site shows the correction in
 * the same place with the same prominence, not both claims side by side.
 */
function applyCorrections(events: readonly EventRecord[]): EventRecord[] {
  const superseded = new Set(
    events.map((event) => event.supersedes).filter((id): id is string => id !== null),
  );
  return events.filter((event) => !superseded.has(event.id));
}

/**
 * Fold generated prose onto the events it explains.
 *
 * The overlay lives in its own file because events are append-only, so the
 * merge happens here at publish time rather than by editing the ledger.
 */
function withSummaries(events: readonly EventRecord[]): EventRecord[] {
  const overlay = readSummarised();
  return events.map((event) => {
    const summary = overlay.get(event.id);
    return summary === undefined
      ? event
      : { ...event, summary: summary.text, summaryState: summary.state };
  });
}

/**
 * Route every visible event to a lens.
 *
 * A correction lands wherever the claim it replaces landed. Without this it
 * would carry `kind: 'correction'`, match no lens, and vanish from the site
 * entirely — the original would disappear and nothing would take its place,
 * which is the opposite of a correction displaying with the same prominence as
 * the thing it corrects.
 */
function groupByLens(
  visible: readonly EventRecord[],
  byId: ReadonlyMap<string, EventRecord>,
): Map<LensName, EventRecord[]> {
  const kindToLens = new Map<EventKind, LensName>();
  for (const lens of LENSES) {
    for (const kind of LENS_KINDS[lens]) kindToLens.set(kind, lens);
  }

  const grouped = new Map<LensName, EventRecord[]>();
  for (const lens of LENSES) grouped.set(lens, []);

  for (const event of visible) {
    const target =
      event.kind === 'correction'
        ? event.supersedes === null
          ? undefined
          : byId.get(event.supersedes)
        : event;

    const lens = target === undefined ? undefined : kindToLens.get(target.kind);
    if (lens !== undefined) grouped.get(lens)?.push(event);
  }

  return grouped;
}

function buildStrip(now: Date, lastDetection: ReadonlyMap<string, string>): StripMark[] {
  const today = utcDate(now);
  const state = readLiveState();
  const windows = new Map(readWindow().map((row) => [row.id, row.samples]));

  const history = new Map<string, DailyForkCount[]>();
  for (let back = 1; back <= DEFAULT_THRESHOLDS.baselineWindowDays; back += 1) {
    const day = utcDate(new Date(now.getTime() - back * 86_400_000));
    for (const row of readSnapshot(day)) {
      const list = history.get(row.id);
      if (list) list.push({ date: row.date, forks: row.forks });
      else history.set(row.id, [{ date: row.date, forks: row.forks }]);
    }
  }

  const marks: StripMark[] = [];

  for (const row of state) {
    if (!row.active) continue;

    const anchor = windowAnchor(windows.get(row.id) ?? [], now.getTime());
    const verdict = classifySpike({
      repo: row.id,
      history: history.get(row.id) ?? [],
      currentForks: row.forks,
      observedAt: now.toISOString(),
      windowStartForks: anchor?.forks ?? null,
      windowStartAt: anchor?.at ?? null,
      // Same input the daily job classified against, so a repository cannot be
      // `confirmed` in the feed and `detected` on the strip at the same time.
      previousDetectionDate: lastDetection.get(row.id) ?? null,
      today,
    });

    marks.push({
      id: row.id,
      delta: verdict.delta,
      multiplier:
        verdict.displayMultiplier === null ? null : roundMultiplier(verdict.displayMultiplier),
      capped: verdict.multiplierCapped,
      state: verdict.state,
      forks: row.forks,
    });
  }

  return marks;
}

function buildLens(
  lens: LensName,
  events: readonly EventRecord[],
  now: Date,
  windowDays: number,
): { bundle: LensBundle; archives: Map<string, EventRecord[]> } {
  const mine = [...events].sort((a, b) =>
    a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0,
  );

  const cutoff = now.getTime() - windowDays * 86_400_000;
  const recent: EventRecord[] = [];
  const archives = new Map<string, EventRecord[]>();

  for (const event of mine) {
    if (Date.parse(event.detectedAt) >= cutoff) {
      recent.push(event);
      continue;
    }
    const month = event.detectedAt.slice(0, 7);
    const list = archives.get(month);
    if (list) list.push(event);
    else archives.set(month, [event]);
  }

  return {
    bundle: {
      lens,
      status: PENDING_LENSES.has(lens) ? 'pending' : 'active',
      records: recent,
      windowDays,
      archives: [...archives.keys()].sort().reverse().map((month) => `${lens}-${month}.json`),
      count: recent.length,
    },
    archives,
  };
}

export function runBuild(options: BuildOptions = {}): BuildResult {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const today = utcDate(now);

  const all = readAllEvents();
  // Indexed before corrections are applied: a correction needs to find the
  // event it replaces, which by then is no longer in the visible set.
  const byId = new Map(all.map((event) => [event.id, event]));

  const events = withSummaries(applyCorrections(all));
  const grouped = groupByLens(events, byId);

  const emitted = new Map<string, string>();
  const lensSummary = {} as IndexBundle['lenses'];

  for (const lens of LENSES) {
    const { bundle, archives } = buildLens(lens, grouped.get(lens) ?? [], now, windowDays);
    emitted.set(`${lens}.json`, stableJson(bundle));
    for (const [month, records] of archives) {
      emitted.set(`${lens}-${month}.json`, stableJson({ lens, month, records }));
    }
    lensSummary[lens] = { status: bundle.status, count: bundle.count };
  }

  const watchlist = readWatchlist();
  const byCategory: Record<string, number> = {};
  for (const entry of watchlist) {
    if (entry.active) byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
  }

  const disclosure: Disclosure = {
    watchlistCurated: true,
    cadenceHours: PULSE_CADENCE_HOURS,
    minBaselineDays: DEFAULT_THRESHOLDS.minBaselineDays,
  };

  const index: IndexBundle = {
    strip: buildStrip(now, lastDetectionByRepo(all)),
    today: events.filter((event) => event.detectedAt.slice(0, 10) === today),
    watchlist: {
      total: watchlist.length,
      active: readActiveWatchlist().length,
      byCategory,
    },
    lenses: lensSummary,
    disclosure,
  };

  emitted.set('index.json', stableJson(index));

  // The gate hashes content only. Run telemetry — timestamps, request counts,
  // remaining budget — changes every run by definition, so including it would
  // mean the hash never matches and the gate never fires.
  //
  // The consequence is deliberate: on a quiet day nothing deploys and the
  // deployed timestamp stays put. That is honest rather than stale, because the
  // timestamp describes when the data on screen was collected, and that data
  // genuinely has not changed.
  const hash = createHash('sha256');
  for (const name of [...emitted.keys()].sort()) {
    hash.update(name);
    hash.update(' ');
    hash.update(emitted.get(name) as string);
  }
  const bundleHash = hash.digest('hex');

  // `meta.bundleHash` is the hash of what was last *successfully deployed*, not
  // the last thing built. Recording it here would mean a failed deployment
  // still marks the bundle as shipped, and the next run would skip deploying
  // something that never went out. `recordDeploy` writes it after the fact.
  const previous = readMeta();
  const deploy = previous.bundleHash !== bundleHash;

  emitted.set('meta.json', stableJson({ ...previous, bundleHash, deploySkipped: !deploy }));

  // Rebuild from scratch so a bundle deleted from the source cannot survive as
  // a stale file the site keeps serving.
  rmSync(DIST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DATA_DIR, { recursive: true });

  const files: BuildResult['files'] = [];
  let totalBytes = 0;

  for (const name of [...emitted.keys()].sort()) {
    const contents = emitted.get(name) as string;
    const bytes = Buffer.byteLength(contents, 'utf8');

    if (bytes > MAX_BUNDLE_BYTES) {
      throw new Error(
        `build: ${name} is ${bytes} bytes, over the ${MAX_BUNDLE_BYTES} limit. Narrow the window or split it.`,
      );
    }

    writeFileSync(join(DIST_DATA_DIR, name), contents, 'utf8');
    files.push({ name, bytes });
    totalBytes += bytes;
  }

  return { files, totalBytes, bundleHash, deploy };
}

/**
 * Record the outcome of a deployment in the committed ledger.
 *
 * Called after the Cloudflare step, not before. `bundleHash` only advances when
 * `deployed` is true, so a failed deployment leaves the gate open and the next
 * run tries again instead of assuming the bundle already shipped.
 */
export function recordDeploy(bundleHash: string, deployed: boolean): MetaRecord {
  const previous = readMeta();
  const meta: MetaRecord = {
    ...previous,
    bundleHash: deployed ? bundleHash : previous.bundleHash,
    deploySkipped: !deployed,
  };
  writeMeta(meta);
  return meta;
}
