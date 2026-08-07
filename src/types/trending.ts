import type { AssertExhaustive } from './keys.ts';

/**
 * A repository somebody else's trending list surfaced, with the thing trending
 * lists never carry.
 *
 * The list is OSSInsight's and is credited as theirs. What is added here is the
 * question a trending list cannot answer, because it is ranked on momentum and
 * momentum says nothing about whether adopting the thing is wise: who is
 * actually writing it.
 */
export interface TrendingRow {
  id: string;
  language: string;
  /** OSSInsight's composite momentum score for the window. Theirs, unaltered. */
  score: number;
  /**
   * Stars gained inside the window, not the repository total.
   *
   * Named for what it is. A field called `stars` holding 2,902 reads as the
   * size of the project rather than as three months of growth, and those are
   * different claims about very different repositories.
   */
  starsGained: number;
  /** Contributors accounting for half the commits. Null when unread. */
  busFactor: number | null;
  /** Share of commits from the largest single contributor, 0 to 1. */
  topShare: number | null;
  /** `YYYY-MM-DD` the window was read on. */
  readAt: string;
  observedAt: string;
}

export const TRENDING_KEYS = [
  'id',
  'language',
  'score',
  'starsGained',
  'busFactor',
  'topShare',
  'readAt',
  'observedAt',
] as const satisfies readonly (keyof TrendingRow)[];

export type _TrendingKeysExhaustive = AssertExhaustive<
  Exclude<keyof TrendingRow, (typeof TRENDING_KEYS)[number]>
>;
