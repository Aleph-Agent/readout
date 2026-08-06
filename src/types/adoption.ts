import type { AssertExhaustive } from './keys.ts';

/**
 * What is actually being installed.
 *
 * GitHub measures what people build. Stars and forks are both cheap to
 * manufacture and neither says whether a line of the code was ever run. A
 * download count is a different kind of evidence: nobody can fake twenty
 * million installs a week, and the divergence between the two — heavy building
 * with no adoption, or quiet adoption with no attention — is the reading this
 * project could not previously take at all.
 *
 * One row per repository per package. Deliberately not summed across
 * registries: an npm week and a Homebrew month are different units over
 * different windows, and adding them together would produce a number that
 * measures nothing.
 */

/** Registries with a free, unauthenticated count. Mirrors `REGISTRIES`. */
export type AdoptionRegistry = 'npm' | 'pypi' | 'crates' | 'brew';

/**
 * The period a count covers, stated rather than assumed.
 *
 * `data-integrity` requires the observation window beside every figure, and
 * these genuinely differ: npm and PyPI report a rolling week, crates.io reports
 * ninety days, Homebrew reports thirty.
 */
export type AdoptionWindow = 'week' | '30d' | '90d';

export interface AdoptionSample {
  /** ISO 8601 UTC of the reading. */
  at: string;
  count: number;
}

export interface AdoptionRow {
  /** Watchlist repository id this package belongs to. */
  id: string;
  registry: AdoptionRegistry;
  /** Package name as the registry spells it. */
  name: string;
  /** Most recent count, or null when the registry could not be read. */
  count: number | null;
  window: AdoptionWindow;
  /**
   * Recent readings, oldest first, pruned to the trend window.
   *
   * Bounded on purpose. An append-only file at this grain would add a megabyte
   * of git history a month to answer a question that only ever looks back a few
   * weeks.
   */
  samples: AdoptionSample[];
}

export const ADOPTION_KEYS = [
  'id',
  'registry',
  'name',
  'count',
  'window',
  'samples',
] as const satisfies readonly (keyof AdoptionRow)[];

export type _AdoptionKeysExhaustive = AssertExhaustive<
  Exclude<keyof AdoptionRow, (typeof ADOPTION_KEYS)[number]>
>;
