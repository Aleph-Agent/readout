import type { AssertExhaustive } from './keys.ts';

/**
 * How many job posts in one month's thread named one technology.
 *
 * A count of posts, never of jobs and never of mentions. One post naming React
 * six times is one post, and a post advertising four roles is still one post.
 */
export interface HiringRow {
  /** `YYYY-MM` of the thread, not of the reading. */
  month: string;
  term: string;
  /** Posts in that month's thread matching this term. */
  posts: number;
  /** Posts in the thread altogether. A count without its sample is not a rate. */
  sample: number;
  /**
   * Whether the pattern behind `posts` is known to undercount.
   *
   * Short names collide with ordinary English — "Go" appears in every other
   * sentence — so those are matched only in unmistakably technical context. The
   * resulting number is a floor rather than a count, and the flag travels with
   * it so no page can present it as the latter.
   */
  conservative: boolean;
}

export const HIRING_KEYS = [
  'month',
  'term',
  'posts',
  'sample',
  'conservative',
] as const satisfies readonly (keyof HiringRow)[];

export type _HiringKeysExhaustive = AssertExhaustive<
  Exclude<keyof HiringRow, (typeof HIRING_KEYS)[number]>
>;
