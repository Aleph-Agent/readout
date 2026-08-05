import type { ConfidenceState, EventRecord } from './events.ts';

/**
 * The static contract between the agent and the site.
 *
 * Visitors read these files and nothing else — no database, no API, no LLM on
 * the request path. That is what makes traffic growth free instead of
 * expensive, and it means the shapes here are the whole interface. Anything the
 * site needs to render honestly has to be present in the JSON.
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
}

export interface WatchlistSummary {
  total: number;
  active: number;
  byCategory: Record<string, number>;
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

export interface IndexBundle {
  strip: StripMark[];
  /** How the project's own confirmed findings have held up so far. */
  scorecard: ScorecardSummary;
  /** Everything detected today, across every lens, newest first. */
  today: EventRecord[];
  watchlist: WatchlistSummary;
  lenses: Record<LensName, { status: CollectorStatus; count: number }>;
  disclosure: Disclosure;
}
