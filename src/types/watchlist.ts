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
  /**
   * Registries this repository actually ships to, as `registry:name`.
   *
   * GitHub measures what people build. It says nothing about what anyone
   * installs, and stars and forks are both cheap to manufacture while a
   * download count is not. This is the join that lets the second question be
   * asked at all.
   *
   * Curated and verified rather than guessed: a mapping is only written after
   * the registry's own record of the package points back at this repository.
   * A wrong mapping would attribute one project's adoption to another, which is
   * the worst class of error this project can make. Empty is the honest answer
   * for a repository that publishes nothing, and most do not publish to every
   * registry.
   *
   * Known registries are in `REGISTRIES`. The prefix is required so the same
   * bare name in two ecosystems can never collide.
   */
  packages: string[];
}

/** Registries with a free, unauthenticated download or install count. */
export const REGISTRIES = ['npm', 'pypi', 'crates', 'brew'] as const;

export type Registry = (typeof REGISTRIES)[number];

export const WATCHLIST_KEYS = [
  'id',
  'category',
  'added',
  'active',
  'packages',
] as const satisfies readonly (keyof WatchlistEntry)[];

export type _WatchlistKeysExhaustive = AssertExhaustive<
  Exclude<keyof WatchlistEntry, (typeof WATCHLIST_KEYS)[number]>
>;
