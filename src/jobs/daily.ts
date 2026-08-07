import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { collectAdoption } from '../collectors/adoption.ts';
import { collectHealth } from '../collectors/health.ts';
import { collectIssues } from '../collectors/issues.ts';
import { collectHiring, type HiringClient } from '../collectors/hiring.ts';
import { collectImages, type ImageClient } from '../collectors/images.ts';
import { collectQuestions, type QuestionClient } from '../collectors/questions.ts';
import { collectStaleness, type StalenessClient } from '../collectors/staleness.ts';
import { collectTyposquats, type TyposquatClient } from '../collectors/typosquat.ts';
import { collectIncidents, type IncidentClient } from '../collectors/incidents.ts';
import { collectLifecycle, type LifecycleClient } from '../collectors/lifecycle.ts';
import { collectModels, type ModelClient } from '../collectors/models.ts';
import { collectManifests } from '../collectors/manifests.ts';
import { lastDetectionByRepo } from '../lib/confidence.ts';
import { createGitHubClient, type GitHubClient } from '../lib/github.ts';
import {
  appendCalibration,
  appendEvents,
  eventId,
  readAdoption,
  readEvents,
  readModels,
  readHiring,
  readImages,
  readQuestions,
  readStaleness,
  readTyposquats,
  readIncidents,
  readLifecycle,
  readAllEvents,
  readLiveState,
  readManifests,
  readMeta,
  readSnapshot,
  readWatchlist,
  readWindow,
  writeAdoption,
  readHealth,
  writeHealth,
  writeModels,
  writeHiring,
  writeImages,
  writeQuestions,
  writeStaleness,
  writeTyposquats,
  writeIncidents,
  writeLifecycle,
  writeManifests,
  writeMeta,
  writeSnapshot,
} from '../lib/ledger.ts';
import { HISTORY_DIR, utcDate, utcMonth } from '../lib/paths.ts';
import {
  classifySpike,
  DEFAULT_THRESHOLDS,
  roundMultiplier,
  type DailyForkCount,
  type SpikeThresholds,
} from '../lib/spikes.ts';
import {
  classifyPeers,
  DEFAULT_PEER_THRESHOLDS,
  type PeerObservation,
} from '../lib/peers.ts';
import { summariseCalibration } from '../lib/calibration.ts';
import { keepOrCarry } from '../lib/carry.ts';
import { DEFAULT_DEMAND_THRESHOLDS } from '../lib/demand.ts';
import { windowAnchor } from '../lib/window.ts';
import type { EventRecord } from '../types/events.ts';
import type { HistorySnapshotRow } from '../types/history.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * The daily job: write the canonical snapshot, then classify spikes against it.
 *
 * History is written once a day rather than once a pulse. Six snapshots daily
 * would multiply repository growth sixfold and buy nothing â€” a baseline only
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
  /** Days of daily-resolution history to keep before weekly thinning. */
  retainDailyDays?: number;
  /**
   * Skip every network collector. Snapshot and spike classification read only
   * what the pulses already collected, so they still run.
   */
  offline?: boolean;
  /**
   * Stand-ins for the collectors that reach a third party.
   *
   * Every one of these took its own client already; none of them was reachable
   * from here, so the whole block behind `offline` had no way to be exercised
   * except by running it against four live APIs. It went out untested and a
   * model price move crashed the entire run — the collectors each worked, and
   * the wiring between them did not.
   *
   * Supplying one runs that collector against the stand-in. Supplying none and
   * setting `offline` skips the block, which is what a build does.
   */
  collectors?: {
    models?: ModelClient;
    lifecycle?: LifecycleClient;
    incidents?: IncidentClient;
    hiring?: HiringClient;
    staleness?: StalenessClient;
    typosquat?: TyposquatClient;
    images?: ImageClient;
    questions?: QuestionClient;
  };
  /** Sleeps between third-party reads. Zero in tests; politeness in production. */
  delayMs?: number;
}

/** Days of daily-resolution history kept before weekly thinning begins. */
const RETAIN_DAILY_DAYS = 90;

/**
 * Collapse old daily snapshots to one per week.
 *
 * Keeps the Monday of each week and removes the rest, but only beyond the
 * retention window, so the trailing baseline never loses resolution it uses.
 * Returns how many files were removed.
 */
function pruneHistory(now: Date, retainDays: number): number {
  if (!existsSync(HISTORY_DIR)) return 0;

  const cutoff = now.getTime() - retainDays * 86_400_000;
  let removed = 0;

  for (const name of readdirSync(HISTORY_DIR)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (match === null) continue;

    const date = new Date(`${match[1] as string}T00:00:00Z`);
    if (date.getTime() >= cutoff) continue;
    // getUTCDay: 1 is Monday. One kept sample per week, chosen by rule rather
    // than by whichever file happened to be first.
    if (date.getUTCDay() === 1) continue;

    rmSync(join(HISTORY_DIR, name));
    removed += 1;
  }

  return removed;
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

  // Every multiplier this run computes, crossing or not. Kept so the project
  // can tell "nothing happened" from "our bar is above the world" â€” see
  // `lib/calibration.ts`. Without it a quiet month is indistinguishable from a
  // broken detector, and the evidence to tell them apart is gone by then.
  const spikeMultipliers: number[] = [];

  /**
   * Findings a collector wrote for itself, counted so the run still reports
   * them.
   *
   * Two collectors append their own findings the moment they have them, rather
   * than handing them to `events` for the single append at the end. That is
   * deliberate for both: their "announce once" rule is decided by a ledger row
   * written in the same breath, so a crash between the two would settle the row
   * and lose the announcement permanently, with nothing left to re-detect it
   * from.
   */
  let appendedByCollectors = 0;

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

    // Recorded before the state check, because the whole point is the readings
    // that do not become events.
    if (verdict.multiplier !== null) spikeMultipliers.push(verdict.multiplier);

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
      summarySource: null,
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

  // Every term that reached the engagement bar, crossing or not. The first live
  // run of this detector published 141 clusters and every one was wrong; the
  // second thing it needed, after tighter filters, was a record of what it is
  // judging so the bar can be checked rather than guessed at again.
  const demandEngagements: number[] = [];

  /**
   * Which third-party collectors run.
   *
   * Nothing supplied means all of them, which is production. Anything supplied
   * means only the ones supplied — a harness that stubs two collectors and
   * quietly sends the other six to the real network is not a harness.
   */
  const only = options.collectors;
  const wanted = (name: keyof NonNullable<DailyOptions['collectors']>): boolean =>
    only === undefined || only[name] !== undefined;

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
      demandEngagements.push(...demand.engagements);
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

    // Adoption. Not GitHub: npm, PyPI, crates.io and Homebrew, all free and
    // unauthenticated, so none of this touches the GitHub budget. Roughly a
    // hundred requests for the whole watchlist, most of it two batch endpoints.
    //
    // Wrapped like every other collector â€” the registries are other people's
    // services and one of them being down must leave the rest of the run
    // intact.
    try {
      const adoption = await collectAdoption(readWatchlist(), readAdoption(), { now: nowIso });
      writeAdoption(adoption.rows);
      errors.push(...adoption.errors);
      for (const registry of adoption.missed) {
        errors.push(`adoption ${registry}: no reading this run, last known counts carried forward`);
      }
    } catch (error) {
      errors.push(`adoption: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Health. deps.dev and OSV, both free and unauthenticated, and neither
    // touching the GitHub budget. Paced, because deps.dev has no batch form and
    // 388 requests fired at once at somebody's free service is rude.
    try {
      // The previous rows go in, or a refused read writes null over a good
      // score and a single failed OSV batch blanks the advisory count for every
      // repository in it. Neither looks like a failure: the row is still there
      // and the figure is a dash, which reads as "never scanned".
      const health = await collectHealth(readWatchlist(), {
        now: nowIso,
        previous: readHealth(),
      });
      writeHealth(health.rows);
      errors.push(...health.errors);
    } catch (error) {
      errors.push(`health: ${error instanceof Error ? error.message : String(error)}`);
    }

    // The model catalogue. One free unauthenticated request for 400 models
    // across 58 providers, and the first reading here with nothing to do with a
    // repository. Prices move weekly and nobody keeps a dated record of them.
    if (wanted('models')) try {
      const models = await collectModels(readModels(), {
        now: nowIso,
        today,
        ...(options.collectors?.models ? { client: options.collectors.models } : {}),
        seen: new Set(readEvents(month).map((event) => event.id)),
      });
      writeModels(models.rows);
      // Written here rather than added to `events`, which is appended in one go
      // at the end. Doing both appended every model finding twice, and the
      // second append is rejected outright — `appendEvents` refuses to rewrite
      // an id it has already seen, which is the right rule and turned a price
      // move into a crash that took the whole run with it.
      if (models.events.length > 0) appendEvents(month, models.events);
      appendedByCollectors += models.events.length;
      errors.push(...models.errors);
    } catch (error) {
      errors.push(`models: ${error instanceof Error ? error.message : String(error)}`);
    }

    // End-of-life dates. Twenty-four curated products, one free request each,
    // and the dates are published years ahead and watched by almost nobody.
    if (wanted('lifecycle')) try {
      const known = readLifecycle();
      const lifecycle = await collectLifecycle(known, {
        now: nowIso,
        today,
        ...(options.collectors?.lifecycle ? { client: options.collectors.lifecycle } : {}),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
        seen: new Set(readEvents(month).map((event) => event.id)),
      });
      // A ledger is never emptied by a bad read. A failed fetch is carried
      // forward inside the collector, but a product that answers 404 is
      // dropped — correct for a rename, catastrophic if the whole API moves and
      // every product answers 404 at once. Stale dates are wrong by days; an
      // empty file is wrong about everything and takes the page with it.
      const keptLifecycle = keepOrCarry('lifecycle', lifecycle.rows, known);
      writeLifecycle(keptLifecycle.rows);
      if (keptLifecycle.error !== null) errors.push(keptLifecycle.error);
      // Appended here, not through `events`. See the models block above.
      if (lifecycle.events.length > 0) appendEvents(month, lifecycle.events);
      appendedByCollectors += lifecycle.events.length;
      errors.push(...lifecycle.errors);
    } catch (error) {
      errors.push(`lifecycle: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Provider incidents. Twenty status feeds, none of them GitHub's problem
    // and none of them charging for this. No events: GitHub alone files
    // incidents most weeks, and a finding apiece would bury every other signal
    // here under somebody else's operational noise.
    if (wanted('incidents')) try {
      const held = readIncidents();
      const incidents = await collectIncidents(held, {
        today,
        ...(options.collectors?.incidents ? { client: options.collectors.incidents } : {}),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      });
      // Same rule as the end-of-life ledger. Twenty feeds failing at once is a
      // network problem, not twenty providers that never had an incident.
      const keptIncidents = keepOrCarry('incidents', incidents.rows, held);
      writeIncidents(keptIncidents.rows);
      if (keptIncidents.error !== null) errors.push(keptIncidents.error);
      errors.push(...incidents.errors);
    } catch (error) {
      errors.push(`incidents: ${error instanceof Error ? error.message : String(error)}`);
    }

    // What employers pay for, from one month's hiring thread. Three requests,
    // no key, and the only demand signal here that somebody spent money to
    // express. Sample is narrow and the page says so beside every number.
    if (wanted('hiring')) try {
      const held = readHiring();
      const hiring = await collectHiring(held, {
        ...(options.collectors?.hiring ? { client: options.collectors.hiring } : {}),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      });
      const keptHiring = keepOrCarry('hiring', hiring.rows, held);
      writeHiring(keptHiring.rows);
      if (keptHiring.error !== null) errors.push(keptHiring.error);
      errors.push(...hiring.errors);
    } catch (error) {
      errors.push(`hiring: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Four readings with nothing to do with GitHub, and none of them charging
    // for the privilege. Each carries its last known values forward on a bad
    // read for the same reason as the ledgers above: an unreadable registry is
    // not a package that stopped existing.
    const tracked = readAdoption();

    if (wanted('staleness')) try {
      const held = readStaleness();
      const staleness = await collectStaleness(tracked, held, {
        now: nowIso,
        ...(options.collectors?.staleness ? { client: options.collectors.staleness } : {}),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      });
      const keptStaleness = keepOrCarry('staleness', staleness.rows, held);
      writeStaleness(keptStaleness.rows);
      if (keptStaleness.error !== null) errors.push(keptStaleness.error);
      errors.push(...staleness.errors);
    } catch (error) {
      errors.push(`staleness: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (wanted('typosquat')) try {
      const held = readTyposquats();
      const squats = await collectTyposquats(tracked, held, {
        now: nowIso,
        limit: 12,
        ...(options.collectors?.typosquat ? { client: options.collectors.typosquat } : {}),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      });
      const keptTyposquats = keepOrCarry('typosquats', squats.rows, held);
      writeTyposquats(keptTyposquats.rows);
      if (keptTyposquats.error !== null) errors.push(keptTyposquats.error);
      errors.push(...squats.errors);
    } catch (error) {
      errors.push(`typosquat: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (wanted('images')) try {
      const held = readImages();
      const images = await collectImages(held, {
        now: nowIso,
        ...(options.collectors?.images ? { client: options.collectors.images } : {}),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      });
      const keptImages = keepOrCarry('images', images.rows, held);
      writeImages(keptImages.rows);
      if (keptImages.error !== null) errors.push(keptImages.error);
      errors.push(...images.errors);
    } catch (error) {
      errors.push(`images: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (wanted('questions')) try {
      const held = readQuestions();
      const questions = await collectQuestions(held, {
        today,
        ...(options.collectors?.questions ? { client: options.collectors.questions } : {}),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      });
      const keptQuestions = keepOrCarry('questions', questions.rows, held);
      writeQuestions(keptQuestions.rows);
      if (keptQuestions.error !== null) errors.push(keptQuestions.error);
      errors.push(...questions.errors);
    } catch (error) {
      errors.push(`questions: ${error instanceof Error ? error.message : String(error)}`);
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

  const peerVerdicts = classifyPeers(observations);
  const peerRatios = peerVerdicts
    .map((peer) => peer.ratio)
    .filter((ratio): ratio is number => ratio !== null);

  for (const peer of peerVerdicts) {
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
      summarySource: null,
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

  // 3b. Calibration. What every threshold was measured against today, whether
  //     or not anything crossed it. This is the only record that can ever say
  //     a detector is set too high, and it can only be written on the day.
  try {
    appendCalibration([
      summariseCalibration(
        today,
        'fork-spike',
        'multiplier against own baseline',
        thresholds.minMultiplier,
        spikeMultipliers,
      ),
      summariseCalibration(
        today,
        'fork-outlier',
        'ratio to category median',
        DEFAULT_PEER_THRESHOLDS.minRatio,
        peerRatios,
      ),
      summariseCalibration(
        today,
        'demand',
        'engagement across repositories',
        DEFAULT_DEMAND_THRESHOLDS.minEngagement,
        demandEngagements,
      ),
    ]);
  } catch (error) {
    // Never fatal. Losing a day of calibration is a gap in a diagnostic; losing
    // the run is a gap in the record itself.
    errors.push(`calibration: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 4. Prune. Snapshots older than 90 days collapse to one per week.
  //
  //    Daily resolution matters for a trailing 30-day baseline and for nothing
  //    else; past that the files are dead weight that every clone of this
  //    repository has to carry forever. Events are never pruned â€” they are the
  //    claims, and the audit trail only means something if it is complete.
  const pruned = pruneHistory(now, options.retainDailyDays ?? RETAIN_DAILY_DAYS);
  if (pruned > 0) console.log(`pruned ${pruned} daily snapshots older than 90 days`);

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
    eventsDetected: events.length + appendedByCollectors,
    collectorsErrored: errors,
  };

  writeMeta(meta);
  return meta;
}
