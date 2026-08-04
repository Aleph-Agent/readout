import type { AssertExhaustive } from './keys.ts';

/**
 * One line of `data/summaries.jsonl` — the outcome of summarising one event.
 *
 * Kept out of the events file on purpose. Events are append-only and never
 * rewritten, because the git history of that file is the audit trail proving
 * nothing was backfilled. Filling in a summary later would mean editing lines
 * that are supposed to be permanent.
 *
 * The separation also matches how the result must be displayed: measurement and
 * interpretation are different things, and the reader has to be able to see
 * where one ends and the other begins.
 */
export interface SummaryRecord {
  /** The event this describes. Matches `EventRecord.id`. */
  eventId: string;
  /**
   * `summarised` — prose exists and passed numeric validation.
   * `skipped`    — the model returned INSUFFICIENT, or generation failed.
   */
  state: 'summarised' | 'skipped';
  /** Generated or templated prose. Null when skipped. */
  text: string | null;
  /**
   * `model`     — the model's own words, validated against the record.
   * `template`  — the model's output was discarded and a certainly-true
   *               sentence substituted. A templated sentence that is certainly
   *               true beats a fluent one that might not be.
   * `none`      — no prose at all.
   */
  source: 'model' | 'template' | 'none';
  /**
   * True when the model returned the literal string INSUFFICIENT. This is a
   * success, not a failure — the rate is logged so thresholds can be tightened
   * when it climbs.
   */
  insufficient: boolean;
  /** Model identifier, for reproducing a result later. Null when templated. */
  model: string | null;
  generatedAt: string;
}

export const SUMMARY_KEYS = [
  'eventId',
  'state',
  'text',
  'source',
  'insufficient',
  'model',
  'generatedAt',
] as const satisfies readonly (keyof SummaryRecord)[];

export type _SummaryKeysExhaustive = AssertExhaustive<
  Exclude<keyof SummaryRecord, (typeof SUMMARY_KEYS)[number]>
>;
