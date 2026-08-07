import type { CalibrationSummary } from '../lib/calibration.ts';
import type { DivergenceSummary } from '../lib/divergence.ts';
import type { AdvisorySummary } from '../lib/advisory-summary.ts';
import type { HiringSummary } from '../lib/hiring-summary.ts';
import type { QuestionSummary } from '../lib/questions-summary.ts';
import type { StalenessSummary } from '../lib/staleness-summary.ts';
import type { IncidentSummary } from '../lib/incidents-summary.ts';
import type { LifecycleSummary } from '../lib/lifecycle-summary.ts';
import type { ModelSummary } from '../lib/models-summary.ts';
import type { ConfidenceState, EventRecord } from './events.ts';

/**
 * The static contract between the agent and the site.
 *
 * Every page is rendered from these files. The one dynamic route, `/api/ask`,
 * reads a bundle built from them and no page depends on it — so the shapes here
 * remain the whole interface, and anything the site needs to render honestly
 * has to be present in the JSON.
 */

export type LensName = 'ships' | 'forks' | 'demand' | 'stack' | 'lineage';

export const LENSES = ['ships', 'forks', 'demand', 'stack', 'lineage'] as const;

/**
 * Whether a lens has a collector behind it yet.
 *
 * An empty `active` lens means the watchlist was checked and nothing crossed
 * the threshold. An empty `pending` lens means nothing has been measured at
 * all. They render identically unless the data says which is which, and
 * conflating them would let the site imply coverage it does not have.
 */
export type CollectorStatus = 'active' | 'pending';

export interface LensBundle {
  lens: LensName;
  status: CollectorStatus;
  /** Newest first. Empty is a valid, honest answer. */
  records: EventRecord[];
  /** Days of history `records` covers. */
  windowDays: number;
  /** Filenames holding older records, one per month, newest first. */
  archives: string[];
  /** Records in this file. Archived records are not counted. */
  count: number;
  /**
   * Findings withdrawn rather than restated.
   *
   * A correction that replaces a claim is shown in place of it. A correction
   * that simply retracts one has nothing to show, and rendering a card per
   * retraction would bury the surviving findings under the mistake. The count
   * is published instead, which discloses the retraction without letting it
   * take over the page. Both the original and the retraction stay in the
   * ledger.
   */
  withdrawn: number;
}

/**
 * One mark on the velocity strip — the signature element.
 *
 * Raw measurements only. How a multiplier becomes a bar height is a visual
 * decision and belongs in the frontend, not baked into the data.
 */
export interface StripMark {
  id: string;
  /** Fork additions across the observation window, or null when unmeasurable. */
  delta: number | null;
  /** Deviation from this repository's own baseline. Null below the floor. */
  multiplier: number | null;
  /** True when the real multiplier exceeded the display cap. */
  capped: boolean;
  /** `forming` and `quiet` are the overwhelming majority. That is correct. */
  state: ConfidenceState | 'quiet';
  forks: number;
  stars: number;
  /** GitHub's primary-language guess. Null for repositories it cannot tell. */
  language: string | null;
  /** The name GitHub uses now, which is not always the id it is watched under. */
  name: string;
  /** Why it is watched, chosen by hand. Not a fact about the repository. */
  category: string;
}

export interface WatchlistSummary {
  total: number;
  active: number;
  byCategory: Record<string, number>;
}

/**
 * One category's share of the instrument's attention.
 *
 * The category is a claim about why a repository is being watched, not a fact
 * about the repository — see `types/watchlist.ts`. Anything rendered from this
 * has to say so, because "79 database repositories" reads as a survey of
 * databases unless it is stated otherwise, and it is not one.
 */
export interface CoverageRow {
  category: string;
  /** Active watchlist entries in this category. */
  repositories: number;
  /** Of those, how many have an observation window long enough to measure. */
  measured: number;
  /** Forks gained across the window, summed over `measured`. Null when zero. */
  forksAdded: number | null;
  /** Findings on record for repositories in this category, all time. */
  findings: number;
  /** The largest single contributor to `forksAdded`, or null when unmeasured. */
  busiest: string | null;
}

/**
 * Facts the site is obliged to disclose somewhere permanent. Emitted as values
 * rather than sentences: the wording is the frontend's job, the honesty is not
 * optional.
 */
export interface Disclosure {
  /** The watchlist is curated, partial, and human-chosen. Never exhaustive. */
  watchlistCurated: true;
  /** Hours between pulses. The data is not real-time and must not claim to be. */
  cadenceHours: number;
  /** Days of baseline required before a spike can be classified at all. */
  minBaselineDays: number;
}

/** See `src/lib/scorecard.ts`. Published whatever it says. */
export interface ScorecardSummary {
  resolved: number;
  followed: number;
  rate: number | null;
  windowDays: number;
  pending: number;
}

/** One package's standing, for the page rather than for the ledger. */
export interface AdoptionReading {
  repo: string;
  registry: string;
  name: string;
  count: number;
  window: string;
}

/**
 * What is being installed, summarised.
 *
 * The one dataset here that is full rather than forming. Everything derived
 * from GitHub needs fourteen days before it can say anything; a download count
 * is a number today, which is why this is what the page leads on.
 */
export interface AdoptionSummary {
  /** Packages with a reading. The sample behind every figure below. */
  measured: number;
  /** Packages mapped but not readable this run. Stated, never counted as zero. */
  unread: number;
  /**
   * Combined weekly downloads across npm and PyPI only.
   *
   * Both report a rolling week, so they add. Homebrew reports a month and
   * crates.io ninety days; folding those in would produce a number measuring
   * nothing, so they are excluded here and shown in the table with their own
   * windows.
   */
  weekly: number;
  /** Packages behind `weekly`. A total without its sample is not a reading. */
  weeklyPackages: number;
  top: AdoptionReading[];
}

/** One project as another body assessed it. */
export interface HealthReading {
  repo: string;
  scorecard: number | null;
  scoredAt: string | null;
  advisories: number | null;
}

/**
 * What other people's analysis says about the watchlist.
 *
 * Not this project's judgement. The score is the OpenSSF Scorecard computed by
 * Google's Open Source Insights and the advisory counts are OSV's; both are
 * cited, because a claim about somebody else's security posture is only
 * defensible when the reader can see who made it.
 */
export interface HealthSummary {
  /** Repositories with a scorecard. Unscanned is not scored zero. */
  scored: number;
  /** Repositories looked up but never scanned by OpenSSF. */
  unscored: number;
  /** Median scorecard across `scored`, or null when nothing is scored. */
  median: number | null;
  /** Advisories filed against everything the watchlist publishes. */
  advisories: number;
  /** Lowest-scoring projects first, which is the only ordering that is useful. */
  weakest: HealthReading[];
}

export interface IndexBundle {
  strip: StripMark[];
  /** What models cost. Nothing to do with a repository. */
  models: ModelSummary;
  /** When runtimes and databases stop getting fixes. See `lib/lifecycle-summary.ts`. */
  lifecycle: LifecycleSummary;
  /** Who went down, as their own status feeds said. See `lib/incidents-summary.ts`. */
  incidents: IncidentSummary;
  /** What employers asked for. See `lib/hiring-summary.ts`. */
  hiring: HiringSummary;
  /** When each package last actually shipped. See `lib/staleness-summary.ts`. */
  staleness: StalenessSummary;
  /** Advisory load per ecosystem. See `lib/advisory-summary.ts`. */
  advisories: AdvisorySummary;
  /** Whether anybody is still asking. See `lib/questions-summary.ts`. */
  questions: QuestionSummary;
  /** Where attention and use disagree. See `lib/divergence.ts`. */
  divergence: DivergenceSummary;
  /** What is actually installed. See `collectors/adoption.ts`. */
  adoption: AdoptionSummary;
  /** What other people's analysis says. See `collectors/health.ts`. */
  health: HealthSummary;
  /** How the project's own confirmed findings have held up so far. */
  scorecard: ScorecardSummary;
  /** Everything detected today, across every lens, newest first. */
  today: EventRecord[];
  watchlist: WatchlistSummary;
  /** What the watchlist is pointed at, one row per category. */
  coverage: CoverageRow[];
  /**
   * Whether each detector's threshold has been reachable at all.
   *
   * Published because the alternative is a page that cannot distinguish a
   * quiet month from a broken detector, and asks the reader to assume the
   * former.
   */
  calibration: CalibrationSummary[];
  lenses: Record<LensName, { status: CollectorStatus; count: number }>;
  disclosure: Disclosure;
}
