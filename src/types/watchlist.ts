import type { AssertExhaustive } from './keys.ts';

/**
 * Editorial grouping. The watchlist is curated and partial by design, and the
 * category is a claim about why a repository is being watched — not a fact
 * about the repository. See `data-integrity`: never present the watchlist as
 * exhaustive.
 */
export type Category =
  | 'ai-ml'
  | 'web-framework'
  | 'database'
  | 'devtool'
  | 'crypto-web3';

export const CATEGORIES = [
  'ai-ml',
  'web-framework',
  'database',
  'devtool',
  'crypto-web3',
] as const satisfies readonly Category[];

/**
 * One line of `data/watchlist.jsonl`.
 *
 * This file is committed, never generated at runtime. Adding or removing an
 * entry is a reviewed commit, because the set of things being watched is
 * itself an editorial claim.
 */
export interface WatchlistEntry {
  /**
   * Canonical `owner/repo` as GitHub spells it, preserving case. GitHub treats
   * the pair case-insensitively for lookup, so `Foo/Bar` and `foo/bar` are the
   * same repository — duplicate detection must fold case, sorting must not
   * depend on it, but the stored value keeps GitHub's casing because it is
   * what gets displayed and linked.
   */
  id: string;
  category: Category;
  /** `YYYY-MM-DD` (UTC) this entry entered the watchlist. */
  added: string;
  /**
   * False once a repository 404s (deleted, renamed, or gone private) or is
   * retired editorially. Inactive entries stay in the file: removing them
   * would erase the record that we ever watched it.
   */
  active: boolean;
}

export const WATCHLIST_KEYS = [
  'id',
  'category',
  'added',
  'active',
] as const satisfies readonly (keyof WatchlistEntry)[];

export type _WatchlistKeysExhaustive = AssertExhaustive<
  Exclude<keyof WatchlistEntry, (typeof WATCHLIST_KEYS)[number]>
>;
