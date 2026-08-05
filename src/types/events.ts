import type { AssertExhaustive } from './keys.ts';

/**
 * How much the project is willing to assert about a signal.
 *
 * `forming`   — under 14 days of baseline. Raw counts only, no multiplier, no
 *               prose. Collect, do not classify.
 * `detected`  — threshold crossed once. Neutral styling, prose permitted,
 *               never alarm styling.
 * `confirmed` — persisted across two consecutive daily snapshots. Only this
 *               state is eligible to leave the site.
 */
export type ConfidenceState = 'forming' | 'detected' | 'confirmed';

/**
 * Whether the LLM has already been spent on this event.
 *
 * `pending`    — cleared the significance threshold, awaiting a summary.
 * `summarised` — a summary exists and passed numeric validation. Never
 *                reprocess: at a 4-hourly cadence, re-summarising multiplies
 *                LLM usage sixfold and breaks the free-tier budget.
 * `skipped`    — below threshold, or generation returned INSUFFICIENT, or
 *                validation rejected the output. Displays raw numbers, no
 *                prose. This is a normal outcome, not a failure.
 */
export type SummaryState = 'pending' | 'summarised' | 'skipped';

export type EventKind =
  | 'release'
  /** Fork activity above this repository's own trailing baseline. */
  | 'fork-spike'
  /**
   * Fork activity above the rest of its category on the same day.
   *
   * A separate kind from `fork-spike` on purpose. "27× its own 30-day baseline"
   * and "eight times the median project in its category today" are different
   * claims resting on different evidence, and one of them is available after a
   * day while the other needs a fortnight. Merging them would let the site
   * imply history it does not have.
   */
  | 'fork-outlier'
  | 'demand-cluster'
  | 'dependency-shift'
  | 'lineage'
  /** Supersedes an earlier event that turned out to be wrong. Never a delete. */
  | 'correction';

/**
 * The structured record a summary is allowed to explain, and nothing else.
 *
 * `data-integrity`'s anchoring rule is enforced against this object: every
 * numeric token in generated prose must appear here, or the summary is
 * discarded in favour of a templated sentence. Keep it flat and keep it to
 * measured values — this is the whole evidence base for a public claim.
 */
export type EventMetrics = Record<string, number | string | null>;

/**
 * One line of `data/events/YYYY-MM.jsonl`.
 *
 * Append-only. Never sorted, never rewritten, never pruned. A wrong event is
 * superseded by a `correction` event carrying the same prominence, because the
 * git history of this file is the audit trail that proves nothing was
 * backfilled.
 */
export interface EventRecord {
  /**
   * Deterministic and stable across runs, so re-detecting the same thing does
   * not append a duplicate. See `eventId()` in `src/lib/ledger.ts`.
   */
  id: string;
  kind: EventKind;
  /** Canonical `owner/repo` this event is about. */
  repo: string;
  /** ISO 8601 UTC of first observation. Never updated on re-observation. */
  detectedAt: string;
  confidence: ConfidenceState;
  summaryState: SummaryState;
  /** Generated prose, or null. Only ever explains numbers in `metrics`. */
  summary: string | null;
  /**
   * Where a reader verifies this themselves — the release page, the repository,
   * the manifest. Required: every claim links to its evidence.
   */
  evidenceUrl: string;
  metrics: EventMetrics;
  /** Event id this corrects, for `kind: 'correction'`. Null otherwise. */
  supersedes: string | null;
}

export const EVENT_KEYS = [
  'id',
  'kind',
  'repo',
  'detectedAt',
  'confidence',
  'summaryState',
  'summary',
  'evidenceUrl',
  'metrics',
  'supersedes',
] as const satisfies readonly (keyof EventRecord)[];

export type _EventKeysExhaustive = AssertExhaustive<
  Exclude<keyof EventRecord, (typeof EVENT_KEYS)[number]>
>;
