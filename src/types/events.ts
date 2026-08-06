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
  /**
   * The repository changed its licence.
   *
   * The only kind here that needs no threshold and has no false-positive mode:
   * an SPDX field either changed between two readings or it did not. Rare, and
   * the rarest thing that actually changes what a team does — every recent
   * open-to-source-available move forked its project within weeks.
   */
  | 'licence'
  /** The repository went read-only. Also a field diff, also unfalsifiable. */
  | 'archived'
  /**
   * A model's price moved. The first kind here that is not about a repository.
   *
   * Prices across sixty providers span four orders of magnitude and move
   * weekly, and no dated record of them exists anywhere — ask what a model cost
   * three months ago and there is no honest answer, which is how teams choose
   * on a price they remember.
   */
  | 'model-price'
  /** A model stopped being offered. Nobody else records this at all. */
  | 'model-withdrawn'
  /**
   * A runtime or database stops receiving security fixes soon.
   *
   * Announced years in advance and watched by almost nobody. A team learns
   * Python 3.9 went unsupported when an auditor tells them.
   */
  | 'eol-approaching'
  /** Supersedes an earlier event that turned out to be wrong. Never a delete. */
  | 'correction';

/**
 * Kinds whose subject is not a repository.
 *
 * `repo` carries the subject for every kind, and for these it holds a model id
 * or a `product/cycle` pair. Both look exactly like `owner/name` and neither is
 * on GitHub, so anything that treats the field as a repository — a profile
 * page, a "view on GitHub" link, a fork baseline — states something false about
 * them. There is no shape to test for; it has to be asked by kind.
 */
const NON_REPOSITORY_KINDS = new Set<EventKind>([
  'model-price',
  'model-withdrawn',
  'eol-approaching',
]);

export function isRepositorySubject(kind: EventKind): boolean {
  return !NON_REPOSITORY_KINDS.has(kind);
}

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
  /** Prose, or null. Only ever explains numbers in `metrics`. */
  summary: string | null;
  /**
   * Where that sentence came from, so the page can say.
   *
   * `template` is measurement restated: assembled from the record, certainly
   * true, adding no reading of its own. `model` is interpretation: a sentence
   * somebody's model wrote, checked against the record but still a reading.
   *
   * They must not look alike. A reader has to be able to see where measurement
   * ends and interpretation begins, and until this existed both arrived in the
   * same typeface with nothing to tell them apart.
   */
  summarySource: 'model' | 'template' | null;
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
  'summarySource',
  'evidenceUrl',
  'metrics',
  'supersedes',
] as const satisfies readonly (keyof EventRecord)[];

export type _EventKeysExhaustive = AssertExhaustive<
  Exclude<keyof EventRecord, (typeof EVENT_KEYS)[number]>
>;
