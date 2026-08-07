import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readActiveWatchlist,
  readAdoption,
  readAllEvents,
  latestCalibration,
  readHealth,
  readContributors,
  readTrending,
  readHiring,
  readImages,
  readQuestions,
  readStaleness,
  readTyposquats,
  readIncidents,
  readLifecycle,
  readModels,
  readManifests,
  readLiveState,
  readMeta,
  readSnapshot,
  readSummarised,
  readWatchlist,
  readWindow,
  writeMeta,
} from './lib/ledger.ts';
import { lastDetectionByRepo } from './lib/confidence.ts';
import { buildCoverage } from './lib/coverage.ts';
import { summariseAdoption } from './lib/adoption-summary.ts';
import { summariseHealth } from './lib/health-summary.ts';
import { summariseDivergence } from './lib/divergence.ts';
import { summariseAdvisories } from './lib/advisory-summary.ts';
import { summariseContributors } from './lib/contributors-summary.ts';
import { summariseTrending } from './lib/trending-summary.ts';
import { summariseImages, summariseNames } from './lib/ecosystem-summary.ts';
import { summariseHiring } from './lib/hiring-summary.ts';
import { summariseQuestions } from './lib/questions-summary.ts';
import { summariseStaleness } from './lib/staleness-summary.ts';
import { summariseIncidents } from './lib/incidents-summary.ts';
import { summariseLifecycle } from './lib/lifecycle-summary.ts';
import { summariseModels } from './lib/models-summary.ts';
import { renderBadge } from './site/badge.ts';
import { summariseWindow, type CalibrationSummary } from './lib/calibration.ts';

/** Detectors whose reachability is published. Order is display order. */
const CALIBRATED_COLLECTORS = ['fork-spike', 'fork-outlier', 'demand', 'lineage'] as const;

/** Matches the baseline window, so both answer questions about the same span. */
const CALIBRATION_WINDOW_DAYS = 30;
import { templatedSentence } from './lib/validate.ts';
import { scoreFindings } from './lib/scorecard.ts';
import { assertSafeRepoId, DIST_DATA_DIR, DIST_DIR, ROOT, utcDate } from './lib/paths.ts';
import { buildAskContext, MAX_CONTEXT_BYTES } from './site/ask-context.ts';
import {
  eventSlug,
  renderCompare,
  renderIndex,
  renderLens,
  renderMethod,
  renderIncidents,
  renderModels,
  renderStack,
  SITE_SCRIPT,
} from './site/render.ts';
import {
  eventPath,
  renderEventPage,
  renderFeed,
  renderRobots,
  renderSitemap,
} from './site/event.ts';
import { archiveNav, archivePath, renderArchive } from './site/archive.ts';
import { renderEcosystem } from './site/ecosystem.ts';
import { renderFindings } from './site/findings.ts';
import { renderWelcome } from './site/welcome.ts';
import { renderHeaders } from './site/headers.ts';
import { renderReadings } from './site/readings-page.ts';
import { DIGEST_DAYS, renderWeek } from './site/week.ts';
import { renderDepends, reverseIndex } from './site/depends.ts';
import { summariseBreaking, summariseCadence } from './lib/releases-summary.ts';
import {
  baselineFromHistory,
  classifySpike,
  DEFAULT_THRESHOLDS,
  roundMultiplier,
  type DailyForkCount,
} from './lib/spikes.ts';
import { windowAnchor } from './lib/window.ts';
import { renderRepoPage, type RepoSeriesPoint } from './site/repo.ts';
import {
  LENSES,
  type Disclosure,
  type IndexBundle,
  type LensBundle,
  type LensName,
  type StripMark,
} from './types/bundles.ts';
import {
  isRepositorySubject,
  type EventKind,
  type EventRecord,
} from './types/events.ts';
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
  forks: ['fork-spike', 'fork-outlier'],
  demand: ['demand-cluster'],
  stack: ['dependency-shift'],
  lineage: ['lineage'],
};

/** Every lens now has a collector. Kept so a future one can be honest about it. */
const PENDING_LENSES = new Set<LensName>();

const SITE_CSS = fileURLToPath(new URL('./site/site.css', import.meta.url));

/**
 * The mark, as a tab icon.
 *
 * There was none, so every tab showed a blank page glyph and a bookmark showed
 * nothing at all — for a site somebody is meant to keep open beside their work.
 * SVG rather than ICO: it is 368 bytes, scales to any density, and every
 * browser that matters has taken it for years.
 */
const FAVICON = fileURLToPath(new URL('./site/favicon.svg', import.meta.url));

/** Timeline entries per profile page. Keeps a long-lived page bounded. */
const MAX_TIMELINE_EVENTS = 200;

/**
 * Page copy. Names things by what the reader is looking at, not by the
 * collector that produced it.
 */
const LENS_COPY: Record<
  LensName,
  { title: string; heading: string; noun: string; scope?: string }
> = {
  ships: { title: 'Ships — releases', heading: 'Releases', noun: 'release' },
  forks: { title: 'Forks — copying above baseline', heading: 'Fork activity', noun: 'fork spike' },
  demand: {
    title: 'Demand — what developers ask for',
    heading: 'Demand',
    noun: 'demand cluster',
    scope:
      'Open issues on the most active repositories in this watchlist, not on GitHub as a whole. ' +
      'A term is only reported once it appears across more than one repository. Terms are derived ' +
      'from issue titles; the titles themselves belong to the people who wrote them and are linked, ' +
      'not reproduced.',
  },
  stack: {
    title: 'Stack — dependency movement',
    heading: 'Dependency movement',
    noun: 'dependency shift',
    // The whole difference between a defensible product and an overclaim.
    scope:
      'One dependency manifest per repository in this watchlist, diffed against the previous day. ' +
      'This says what the repositories we watch are doing. It is not a survey of the ecosystem and ' +
      'nothing here should be read as one.',
  },
  lineage: { title: 'Lineage — model descent', heading: 'Lineage', noun: 'lineage relation' },
};

/**
 * Self-hosted so the read path depends on nothing but Pages. A font CDN would
 * put a third party between a visitor and a page that is otherwise entirely
 * ours to serve.
 */
const FONT_FILES = [
  '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-500-normal.woff2',
  '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-600-normal.woff2',
  '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
  '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2',
  '@fontsource/ibm-plex-serif/files/ibm-plex-serif-latin-400-normal.woff2',
];

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
    if (summary !== undefined && summary.text !== null) {
      return {
        ...event,
        summary: summary.text,
        summaryState: summary.state,
        summarySource: summary.source === 'model' ? 'model' : 'template',
      };
    }

    // Everything else gets the templated sentence. It is assembled from the
    // record and certainly true, and a finding that states itself in words is
    // easier to read than one that leaves the reader to assemble the sentence
    // out of labelled numbers. It is marked as assembled, not written.
    const templated = templatedSentence(event);
    return templated === null
      ? event
      : { ...event, summary: templated, summarySource: 'template' };
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

/**
 * Daily snapshots for the baseline window, oldest first per repository.
 *
 * Read once and shared: the strip needs it for every repository and so does
 * every profile page, and re-reading thirty files four hundred times would make
 * the build quadratic for no reason.
 */
function readHistorySeries(now: Date, days: number): Map<string, DailyForkCount[]> {
  const history = new Map<string, DailyForkCount[]>();

  for (let back = days; back >= 1; back -= 1) {
    const day = utcDate(new Date(now.getTime() - back * 86_400_000));
    for (const row of readSnapshot(day)) {
      const list = history.get(row.id);
      if (list) list.push({ date: row.date, forks: row.forks });
      else history.set(row.id, [{ date: row.date, forks: row.forks }]);
    }
  }

  return history;
}

/** Totals differenced into daily additions, which is what the chart plots. */
function toSeries(history: readonly DailyForkCount[]): RepoSeriesPoint[] {
  return history.map((point, i) => {
    const previous = history[i - 1];
    return {
      date: point.date,
      forks: point.forks,
      added: previous === undefined ? 0 : Math.max(0, point.forks - previous.forks),
    };
  });
}

function buildStrip(
  now: Date,
  lastDetection: ReadonlyMap<string, string>,
  history: ReadonlyMap<string, DailyForkCount[]>,
  categoryOf: ReadonlyMap<string, string>,
): StripMark[] {
  const today = utcDate(now);
  const state = readLiveState();
  const windows = new Map(readWindow().map((row) => [row.id, row.samples]));

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
      stars: row.stars,
      language: row.language,
      name: row.fullName ?? row.id,
      // Every state row is a watchlist row, so the lookup cannot miss. The
      // fallback exists so a schema drift renders as an unclassified repository
      // rather than throwing the whole build.
      category: categoryOf.get(row.id) ?? 'unclassified',
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
  let withdrawn = 0;

  for (const event of mine) {
    // A retraction has nothing to display in place of what it removed. Count
    // it, disclose the count, and keep both records in the ledger.
    if (event.kind === 'correction' && event.metrics['withdrawn'] === 'yes') {
      withdrawn += 1;
      continue;
    }

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
      withdrawn,
    },
    archives,
  };
}

/**
 * Fail the build on a link that goes nowhere.
 *
 * This exists because 141 of them shipped. Repository timelines linked every
 * entry to its own page, including retractions, which have none. Nothing
 * checked, so nothing complained, and the only reason it was found at all was
 * somebody looking.
 *
 * Cheap to run and it turns a class of silent breakage into a failed build.
 */
function assertNoDeadInternalLinks(pages: ReadonlyMap<string, string>): void {
  const served = new Set<string>(['/']);
  for (const name of pages.keys()) {
    served.add(`/${name.replace(/\.html$/, '')}`);
    served.add(`/${name}`);
  }

  const dead = new Set<string>();

  for (const [name, html] of pages) {
    if (!name.endsWith('.html')) continue;
    for (const match of html.matchAll(/href="(\/[^"#?]*)"/g)) {
      const target = (match[1] as string).replace(/\/$/, '') || '/';
      // Assets are written outside the page map; only pages are checked here.
      if (/\.(css|json|xml|txt|woff2?|png|svg)$/.test(target)) continue;
      if (!served.has(target)) dead.add(target);
    }
  }

  if (dead.size > 0) {
    const sample = [...dead].slice(0, 5).join(', ');
    throw new Error(
      `build: ${dead.size} internal link${dead.size === 1 ? '' : 's'} point at pages that are not generated (${sample}${dead.size > 5 ? ', …' : ''})`,
    );
  }
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

  // Retractions are filtered once, here, and every consumer works from the
  // result. Filtering them per-view is how the same bug appeared three times:
  // dead links from repository timelines, from the index table, and from
  // finding pages that had no repository page to point at.
  const addressable = events.filter(
    (event) => !(event.kind === 'correction' && event.metrics['withdrawn'] === 'yes'),
  );

  const grouped = groupByLens(events, byId);

  const emitted = new Map<string, string>();
  const lensSummary = {} as IndexBundle['lenses'];
  const lensBundles = new Map<LensName, LensBundle>();
  const lensArchives = new Map<LensName, Map<string, EventRecord[]>>();

  for (const lens of LENSES) {
    const { bundle, archives } = buildLens(lens, grouped.get(lens) ?? [], now, windowDays);
    lensBundles.set(lens, bundle);
    lensArchives.set(lens, archives);
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

  const history = readHistorySeries(now, DEFAULT_THRESHOLDS.baselineWindowDays);

  // Thirty days, matching the baseline window. A shorter window would let one
  // quiet fortnight read as a broken detector; a longer one would keep saying a
  // threshold is fine long after the data moved away from it.
  const calibrationFloor = utcDate(new Date(now.getTime() - CALIBRATION_WINDOW_DAYS * 86_400_000));
  const calibrationWindow = latestCalibration().filter((row) => row.date >= calibrationFloor);

  const categoryOf = new Map(watchlist.map((entry) => [entry.id, entry.category as string]));
  // Read before anything that stamps a time. The ask context is dated with the
  // last successful reading rather than with `now`, so this has to exist before
  // the bundles are built — see the comment there.
  const previous = readMeta();

  const strip = buildStrip(now, lastDetectionByRepo(all), history, categoryOf);

  // Weekly installs per repository, largest across the packages it publishes.
  // npm and PyPI only: those two report a rolling week and so can be compared
  // with each other. Declared here because the index needs it — divergence is
  // computed from it — and the bundles below need it too.
  const adoptionByRepo = new Map<string, number>();
  for (const row of readAdoption()) {
    if (row.count === null || (row.registry !== 'npm' && row.registry !== 'pypi')) continue;
    adoptionByRepo.set(row.id, Math.max(adoptionByRepo.get(row.id) ?? 0, row.count));
  }
  const healthByRepo = new Map(readHealth().map((row) => [row.id, row]));

  const index: IndexBundle = {
    strip,
    adoption: summariseAdoption(readAdoption()),
    health: summariseHealth(readHealth()),
    models: summariseModels(readModels()),
    lifecycle: summariseLifecycle(readLifecycle(), today),
    incidents: summariseIncidents(readIncidents(), today),
    hiring: summariseHiring(readHiring()),
    staleness: summariseStaleness(readStaleness(), today),
    advisories: summariseAdvisories(readAdoption(), readHealth()),
    questions: summariseQuestions(readQuestions()),
    images: summariseImages(readImages(), today),
    names: summariseNames(readTyposquats()),
    contributors: summariseContributors(readContributors()),
    trending: summariseTrending(readTrending()),
    divergence: summariseDivergence(
      strip.map((mark) => ({
        id: mark.id,
        name: mark.name,
        stars: mark.stars,
        installs: adoptionByRepo.get(mark.id) ?? null,
      })),
    ),
    scorecard: scoreFindings(all, now),
    today: addressable.filter((event) => event.detectedAt.slice(0, 10) === today),
    watchlist: {
      total: watchlist.length,
      active: readActiveWatchlist().length,
      byCategory,
    },
    coverage: buildCoverage(watchlist, strip, addressable),
    calibration: CALIBRATED_COLLECTORS.map((collector) =>
      summariseWindow(calibrationWindow, collector),
    ).filter((summary): summary is CalibrationSummary => summary !== null),
    lenses: lensSummary,
    disclosure,
  };

  emitted.set('index.json', stableJson(index));

  // What the ask endpoint is allowed to answer from. Published as a static file
  // like every other bundle: the endpoint fetches it from this same deployment,
  // so the model's grounding is a URL anybody can open and check against the
  // answer they were given.
  // Stamped with when the readings were taken, not with when this file was
  // written. Those are different facts and only one of them is a property of
  // the data — `now` made this the single non-deterministic file in the build,
  // which broke the byte-identical guarantee this module's own docstring rests
  // the deploy gate on. It is also the more honest of the two: a reader asking
  // how fresh the grounding is wants the reading time.
  const askContext = stableJson(
    buildAskContext(
      index,
      addressable,
      index.strip,
      previous.lastSuccessfulRunAt ?? now.toISOString(),
    ),
  );

  // Asserted here rather than discovered in production. Groq's free tier counts
  // a single request against a 6,000-token-per-minute allowance and refuses
  // anything over it outright — not throttled, refused, every time. The first
  // version of this file shipped at 18KB and the endpoint never answered once.
  // The ledger only grows, so without this it would go quietly dead again on
  // whichever day it crossed back over.
  if (Buffer.byteLength(askContext, 'utf8') > MAX_CONTEXT_BYTES) {
    throw new Error(
      `build: ask-context.json is ${Buffer.byteLength(askContext, 'utf8')} bytes, over the ` +
        `${MAX_CONTEXT_BYTES} the answer endpoint can send. Lower MAX_FINDINGS in ask-context.ts.`,
    );
  }

  emitted.set('ask-context.json', askContext);

  // One row per watched repository, flattened across every axis this project
  // reads. Fetched only by /compare, never by the index — 388 rows is small,
  // but it is not small enough to put on a page that does not use it.
  const findingsByRepo = new Map<string, number>();
  for (const event of addressable) {
    findingsByRepo.set(event.repo, (findingsByRepo.get(event.repo) ?? 0) + 1);
  }

  // Keyed by package rather than by repository, because a visitor's manifest
  // names packages and has no idea which repository publishes them. This is
  // what lets the instrument be pointed at somebody else's stack instead of at
  // a list they did not choose.
  const liveById = new Map(readLiveState().map((row) => [row.id, row]));
  const stackIndex: Record<string, unknown> = {};
  for (const entry of watchlist) {
    if (!entry.active) continue;
    const health = healthByRepo.get(entry.id);
    for (const packageId of entry.packages ?? []) {
      const separator = packageId.indexOf(':');
      const registry = packageId.slice(0, separator);
      const name = packageId.slice(separator + 1);
      if (registry === 'brew' || name === '') continue;

      stackIndex[`${registry}:${name}`] = {
        repo: entry.id,
        installs: adoptionByRepo.get(entry.id) ?? null,
        scorecard: health?.scorecard ?? null,
        advisories: health?.advisories ?? null,
        license: liveById.get(entry.id)?.license ?? null,
        archived: liveById.get(entry.id)?.archived ?? false,
        pushedAt: liveById.get(entry.id)?.pushedAt ?? null,
      };
    }
  }

  // Every tracked runtime and its cycles, flat. An agent asked "is Python 3.9
  // still supported" answers it from training data with a date in it, which is
  // the one kind of question where stale training data is confidently wrong.
  emitted.set(
    'eol.json',
    stableJson({
      generatedAt: previous.lastSuccessfulRunAt ?? now.toISOString(),
      source: 'https://endoflife.date',
      products: readLifecycle().map((row) => ({
        product: row.product,
        cycle: row.cycle,
        eol: row.eol,
        ended: row.ended,
        latest: row.latest,
        lts: row.lts,
      })),
    }),
  );

  // The four readings that have nothing to do with GitHub, published flat so an
  // agent can read them without scraping a page.
  emitted.set(
    'ecosystem.json',
    stableJson({
      generatedAt: previous.lastSuccessfulRunAt ?? now.toISOString(),
      note: 'Registry publish dates, base image sizes, question volume, and near-miss package names. None of this comes from GitHub.',
      lastPublish: readStaleness(),
      baseImages: readImages(),
      questions: readQuestions(),
      // Names one edit from a tracked package. Existence only — this is not a
      // claim that any of them is malicious, and nothing may present it as one.
      nearMissNames: readTyposquats(),
    }),
  );

  // Every incident on record, flat. The whole reason this file exists is that
  // the providers' own feeds stop carrying their history, so republishing it as
  // one document is the part nobody else does.
  emitted.set(
    'incidents.json',
    stableJson({
      generatedAt: previous.lastSuccessfulRunAt ?? now.toISOString(),
      note: 'Incidents as each provider announced them. A count measures disclosure as much as reliability.',
      incidents: readIncidents(),
    }),
  );

  // Every model, flat, for the endpoint that answers "cheapest with 200k
  // context". An agent asks that several times a session and currently answers
  // it from training data a year old.
  emitted.set(
    'models.json',
    stableJson(
      readModels()
        .filter((row) => row.available)
        .map((row) => ({
          id: row.id,
          provider: row.provider,
          prompt: row.prompt,
          completion: row.completion,
          context: row.context,
          firstSeen: row.firstSeen,
        })),
    ),
  );

  // How many watched projects depend on each package.
  //
  // Built from manifests.jsonl, which has been collected since Prompt 5, is the
  // largest file in the ledger, and had never been read by anything. It turns a
  // dependency from a name into a position: forty-seven tracked projects
  // depending on something makes it infrastructure, and one makes it a choice
  // somebody made alone.
  const dependents = new Map<string, number>();
  for (const manifest of readManifests()) {
    for (const name of Object.keys(manifest.deps ?? {})) {
      // Case-folded, and underscores folded to hyphens. PyPI treats PyYAML and
      // pyyaml as one package and npm forbids uppercase outright; counting them
      // separately splits the tally and understates every Python dependency.
      // It also produced two keys differing only by case in the same JSON
      // object, which is legal and which several parsers refuse to read.
      const clean = name.trim().toLowerCase().replace(/_/g, '-');
      if (clean === '') continue;
      dependents.set(clean, (dependents.get(clean) ?? 0) + 1);
    }
  }

  emitted.set(
    'stack-index.json',
    stableJson({
      // Only packages more than one watched project depends on. A count of one
      // is not a finding, and carrying six thousand of them would triple the
      // file to say nothing.
      dependents: Object.fromEntries(
        [...dependents.entries()].filter(([, count]) => count > 1).sort(),
      ),
      // The corpus is what makes a visitor's number mean anything: "5.2" is
      // not a reading until it sits beside what 388 tracked projects median.
      benchmark: {
        repositories: index.watchlist.active,
        medianScorecard: index.health.median,
        scored: index.health.scored,
      },
      packages: stackIndex,
    }),
  );

  emitted.set(
    'compare.json',
    stableJson(
      strip.map((mark) => ({
        id: mark.id,
        name: mark.name,
        category: mark.category,
        language: mark.language,
        forks: mark.forks,
        stars: mark.stars,
        installs: adoptionByRepo.get(mark.id) ?? null,
        scorecard: healthByRepo.get(mark.id)?.scorecard ?? null,
        advisories: healthByRepo.get(mark.id)?.advisories ?? null,
        findings: findingsByRepo.get(mark.id) ?? 0,
      })),
    ),
  );

  const pages = new Map<string, string>([
    // The front door, and the instrument behind it. Exactly one URL moved:
    // everything anybody has linked to is where it was.
    ['index.html', renderWelcome(index, previous)],
    ['live.html', renderIndex(index, previous)],
    // The channel list. One screen that says what the whole instrument measures,
    // which fifteen one-word navigation labels never did.
    ['readings.html', renderReadings(index, previous)],
    ...LENSES.map(
      (lens) =>
        [
          `${lens}.html`,
          renderLens(
            lensBundles.get(lens) as LensBundle,
            index,
            previous,
            LENS_COPY[lens],
            archiveNav(lens, [...(lensArchives.get(lens)?.keys() ?? [])].sort().reverse()),
          ),
        ] as const,
    ),
  ]);

  // Archive bundles were already being written and nothing linked to them, so
  // every finding past the window was published and unreachable at once.
  for (const lens of LENSES) {
    for (const [month, records] of lensArchives.get(lens) ?? []) {
      pages.set(
        `${lens}-${month}.html`,
        renderArchive(lens, month, records, index, previous, LENS_COPY[lens].heading),
      );
    }
  }

  // One page per watched repository, including the ones with nothing recorded.
  // A repository the agent has never had anything to say about still deserves a
  // page that says so honestly, rather than a 404 that reads as a broken link.
  const stateById = new Map(readLiveState().map((row) => [row.id, row]));
  const eventsByRepo = new Map<string, EventRecord[]>();
  for (const event of addressable) {
    const list = eventsByRepo.get(event.repo);
    if (list) list.push(event);
    else eventsByRepo.set(event.repo, [event]);
  }

  // Every watched repository, plus any repository that has events but has since
  // been removed. Its findings are permanent and they link here; dropping the
  // page would turn each of them into a dead link.
  const watched = new Map(watchlist.map((entry) => [entry.id, entry]));
  const profiles = new Map(watched);

  for (const [repo, repoEvents] of eventsByRepo) {
    if (profiles.has(repo)) continue;
    // A model id and a `product/cycle` pair both fit `owner/name`. Given a
    // profile page they were described as repositories removed from the
    // watchlist, with a fork baseline and a link to GitHub — four false
    // statements about a thing that was never a repository. Their findings
    // address at `/e/…` instead.
    if (!repoEvents.some((event) => isRepositorySubject(event.kind))) continue;
    const earliest = repoEvents.reduce(
      (oldest, event) => (event.detectedAt < oldest ? event.detectedAt : oldest),
      repoEvents[0]?.detectedAt ?? now.toISOString(),
    );
    profiles.set(repo, {
      id: repo,
      category: 'devtool',
      added: earliest.slice(0, 10),
      active: false,
      // A repository off the watchlist is no longer read, so nothing is being
      // counted for it in any registry either.
      packages: [],
    });
  }

  for (const entry of profiles.values()) {
    const series = toSeries(history.get(entry.id) ?? []);
    const baseline = baselineFromHistory(history.get(entry.id) ?? [], today);

    const repoEvents = (eventsByRepo.get(entry.id) ?? [])
      .slice()
      .sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0));

    pages.set(
      // Validated here rather than trusted: this string becomes a filesystem
      // path a few lines below.
      `repo/${assertSafeRepoId(entry.id)}.html`,
      renderRepoPage(
        {
          entry,
          onWatchlist: watched.has(entry.id),
          state: stateById.get(entry.id) ?? null,
          series,
          baselinePerDay: baseline.perDay,
          baselineDays: baseline.days,
          health: healthByRepo.get(entry.id) ?? null,
          installs: adoptionByRepo.get(entry.id) ?? null,
          events: repoEvents.slice(0, MAX_TIMELINE_EVENTS),
          totalEvents: repoEvents.length,
        },
        index,
        previous,
      ),
    );
  }

  // One page per finding. What anybody shares is a single reading, and until
  // there is an address for one there is no way to send it to somebody.
  const slugs = new Set<string>();
  for (const event of addressable) {
    const slug = eventSlug(event.id);
    if (slugs.has(slug)) {
      throw new Error(`build: two events share the slug "${slug}"; ids must stay distinguishable`);
    }
    slugs.add(slug);
    pages.set(`e/${slug}.html`, renderEventPage(event, index, previous));
  }

  pages.set('method.html', renderMethod(index, previous));
  pages.set('compare.html', renderCompare(index, previous));
  pages.set('stack.html', renderStack(index, previous));
  pages.set('models.html', renderModels(index, previous));
  pages.set('incidents.html', renderIncidents(index, previous));
  pages.set('ecosystem.html', renderEcosystem(index, previous));
  pages.set('findings.html', renderFindings(index, previous));
  pages.set('depends.html', renderDepends(reverseIndex(readManifests()), index, previous));

  // Everything the ledger already holds, arranged for somebody who was away.
  // The homepage answers what happened today and each lens answers one signal;
  // neither answers what a reader who checks weekly actually wants.
  const weekFrom = utcDate(new Date(now.getTime() - DIGEST_DAYS * 86_400_000));
  pages.set(
    'week.html',
    renderWeek(
      {
        events: addressable.filter((event) => event.detectedAt.slice(0, 10) >= weekFrom),
        cadence: summariseCadence(all, today),
        breaking: summariseBreaking(all),
        today,
      },
      index,
      previous,
    ),
  );

  // One feed per repository that has anything to say. The site-wide feed is
  // four hundred projects of noise to somebody who depends on one of them, and
  // a feed nobody keeps subscribed is a channel this project does not have.
  for (const [repo, repoEvents] of eventsByRepo) {
    if (!profiles.has(repo)) continue;
    if (!repoEvents.some((event) => event.confidence === 'confirmed')) continue;
    pages.set(
      `repo/${assertSafeRepoId(repo)}.xml`,
      renderFeed(
        [...repoEvents].sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : -1)),
        previous.lastSuccessfulRunAt ?? now.toISOString(),
        { repo, path: `/repo/${repo}` },
      ),
    );
  }

  // One badge per watched repository. A maintainer who embeds one puts a
  // permanent link back in a README that may be read more in a week than this
  // site is read in a year, and it costs a static file each.
  for (const mark of strip) {
    pages.set(
      `badge/${assertSafeRepoId(mark.id)}.svg`,
      renderBadge({
        repo: mark.name,
        health: healthByRepo.get(mark.id),
        installs: adoptionByRepo.get(mark.id) ?? null,
      }),
    );
  }

  const sitemapPaths = [
    '/',
    '/method',
    '/compare',
    '/stack',
    '/models',
    '/incidents',
    '/ecosystem',
    '/findings',
    '/live',
    '/depends',
    '/week',
    ...LENSES.map((lens) => `/${lens}`),
    ...[...profiles.keys()].map((repo) => `/repo/${repo}`),
    ...addressable.map((event) => eventPath(event)),
    ...LENSES.flatMap((lens) =>
      [...(lensArchives.get(lens)?.keys() ?? [])].map((month) => archivePath(lens, month)),
    ),
  ];

  // One script for the whole site rather than 12.6KB inlined into all 653
  // pages, most of which use none of it.
  pages.set('site.js', SITE_SCRIPT);

  pages.set('feed.xml', renderFeed(addressable, previous.lastSuccessfulRunAt ?? now.toISOString()));
  pages.set('sitemap.xml', renderSitemap(sitemapPaths));
  pages.set('robots.txt', renderRobots());

  // Owed since the audit and deferred while the site was read-only. Sign-in
  // ended the deferral: there is now a session cookie worth stealing.
  pages.set('_headers', renderHeaders());
  pages.set(
    '_redirects',
    readFileSync(fileURLToPath(new URL('./site/redirects.txt', import.meta.url)), 'utf8'),
  );

  // The gate hashes everything served — bundles, pages, and the stylesheet — so
  // a change to any of them deploys. Hashing only the JSON would have meant a
  // CSS or template edit never reaching the site.
  //
  // Computed here rather than where `pages` was first assembled, which is where
  // it used to sit: at that point the map held the index and the five lenses and
  // nothing else. Every page added afterwards — method, compare, stack, models,
  // every finding page, every badge, the feed, the sitemap, `site.js` — was
  // outside the hash, so an edit touching only those produced an unchanged hash
  // and a skipped deploy. The gate silently refused to ship the change, and the
  // docstring above it claimed the opposite.
  //
  // Two exceptions. meta.json is excluded because it carries the hash and
  // cannot hash itself. And lastSuccessfulRunAt is folded in deliberately,
  // despite being run telemetry.
  //
  // That second one reverses the decision made in Prompt 4. Excluding it meant
  // a quiet day deployed nothing and the published timestamp stayed put, which
  // was defensible while the output was only JSON. But the page derives a
  // staleness warning from that timestamp, and skipping the deploy would make a
  // healthy agent that found nothing indistinguishable from a dead one — the
  // exact failure the staleness warning exists to expose. Freshness wins. The
  // cost is roughly 210 deployments a month against a ceiling of 500.
  const hash = createHash('sha256');
  const hashed = new Map([...emitted, ...pages]);
  for (const name of [...hashed.keys()].sort()) {
    hash.update(`${name} ${hashed.get(name) as string}`);
  }
  hash.update(readFileSync(SITE_CSS, 'utf8'));
  hash.update(previous.lastSuccessfulRunAt ?? 'never');
  const bundleHash = hash.digest('hex');

  // `meta.bundleHash` is the hash of what was last *successfully deployed*, not
  // the last thing built. Recording it here would mean a failed deployment
  // still marks the bundle as shipped, and the next run would skip deploying
  // something that never went out. `recordDeploy` writes it after the fact.
  const deploy = previous.bundleHash !== bundleHash;

  emitted.set('meta.json', stableJson({ ...previous, bundleHash, deploySkipped: !deploy }));

  // Rebuild from scratch so a file deleted from the source cannot survive as a
  // stale asset the site keeps serving.
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DATA_DIR, { recursive: true });

  assertNoDeadInternalLinks(pages);

  const files: BuildResult['files'] = [];
  let totalBytes = 0;

  // Pages, stylesheet, and fonts sit at the root; bundles live under /data so
  // the published data is a first-class URL rather than an implementation
  // detail. Readers checking a claim should be able to fetch the same file.
  for (const [name, contents] of pages) {
    const target = join(DIST_DIR, name);
    // Profile pages nest under repo/{owner}/{name}.html.
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
    const bytes = Buffer.byteLength(contents, 'utf8');
    files.push({ name, bytes });
    totalBytes += bytes;
  }

  copyFileSync(SITE_CSS, join(DIST_DIR, 'site.css'));
  copyFileSync(FAVICON, join(DIST_DIR, 'favicon.svg'));

  // The share card. Every link to this site posted anywhere rendered as a blank
  // box until this existed, which is a poor showing for a project whose only
  // distribution is people posting links to it.
  copyFileSync(join(ROOT, 'assets', 'brand', 'banner.png'), join(DIST_DIR, 'share.png'));

  const fontDir = join(DIST_DIR, 'fonts');
  mkdirSync(fontDir, { recursive: true });
  for (const relative of FONT_FILES) {
    const source = join(ROOT, 'node_modules', relative);
    copyFileSync(source, join(fontDir, relative.split('/').pop() as string));
  }

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

  // The gate's own invariant, asserted rather than trusted. It went wrong once
  // by construction — the hash was computed halfway through assembling `pages`,
  // so two thirds of the site sat outside it — and the failure was silent: a
  // correct build, a matching hash, and a deploy that never happened. A build
  // that serves a file it did not hash should stop here instead.
  for (const file of files) {
    if (file.name === 'meta.json') continue;
    if (hashed.has(file.name)) continue;
    throw new Error(
      `build: ${file.name} is served but was not hashed, so a change to it would not deploy`,
    );
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
