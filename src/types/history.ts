import type { AssertExhaustive } from './keys.ts';

/**
 * One line of `data/history/YYYY-MM-DD.jsonl`.
 *
 * Written once per day, never rewritten. Six snapshots a day would multiply
 * repository growth sixfold for no analytical gain — baselines only need daily
 * resolution.
 *
 * This is the substrate the spike detector reads: a trailing 30-day mean of
 * daily fork additions comes from differencing consecutive files.
 */
export interface HistorySnapshotRow {
  /** Canonical `owner/repo`. */
  id: string;
  /**
   * `YYYY-MM-DD` (UTC) of the snapshot. Constant within a file and therefore
   * free in diff terms, but it survives concatenation — the rolling-window
   * maths reads many files at once and needs each row to say when it is from.
   */
  date: string;
  forks: number;
  stars: number;
  openIssues: number;
}

export const HISTORY_KEYS = [
  'id',
  'date',
  'forks',
  'stars',
  'openIssues',
] as const satisfies readonly (keyof HistorySnapshotRow)[];

export type _HistoryKeysExhaustive = AssertExhaustive<
  Exclude<keyof HistorySnapshotRow, (typeof HISTORY_KEYS)[number]>
>;
