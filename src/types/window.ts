import type { AssertExhaustive } from './keys.ts';

/**
 * One timestamped fork reading.
 *
 * The rolling 24-hour delta the spike detector needs cannot come from anywhere
 * else in the layout: `live/state.jsonl` deliberately carries no per-row
 * timestamp, and `history/` only has daily resolution. This file is the
 * smallest thing that makes a genuine rolling window possible.
 */
export interface ForkSample {
  /** ISO 8601 UTC. */
  at: string;
  forks: number;
}

/**
 * One line of `data/live/window.jsonl`.
 *
 * A sample is only appended when the fork count actually changed, or when the
 * newest sample has aged past the window and a fresh anchor is needed. A
 * dormant repository therefore produces no diff at all — churn tracks real
 * activity rather than pulse frequency.
 */
export interface WindowRow {
  id: string;
  /** Ascending by `at`, pruned to the anchor and everything newer. */
  samples: ForkSample[];
}

export const WINDOW_KEYS = ['id', 'samples'] as const satisfies readonly (keyof WindowRow)[];

export type _WindowKeysExhaustive = AssertExhaustive<
  Exclude<keyof WindowRow, (typeof WINDOW_KEYS)[number]>
>;
