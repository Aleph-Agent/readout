import type { AssertExhaustive } from './keys.ts';

/**
 * How concentrated a project's commit history is.
 *
 * Every "is this healthy" signal in circulation measures activity. None of them
 * measures who is producing it, and that is the difference between a project
 * that survives a maintainer leaving and one that does not. A repository with
 * ten thousand commits from one person looks identical on every chart to one
 * with ten thousand from forty.
 */
export interface ContributorRow {
  id: string;
  /**
   * Contributors accounting for half of all commits, fewest first.
   *
   * The bus factor as usually defined. One means half this project's history
   * came from a single person.
   */
  busFactor: number;
  /** Share of commits from the single largest contributor, 0 to 1. */
  topShare: number;
  /** Contributors read. Capped by the page size — see the collector. */
  contributors: number;
  /** Commits across those contributors. The sample every share rests on. */
  commits: number;
  /** True when the list was truncated, so `contributors` is a floor. */
  truncated: boolean;
  observedAt: string;
}

export const CONTRIBUTOR_KEYS = [
  'id',
  'busFactor',
  'topShare',
  'contributors',
  'commits',
  'truncated',
  'observedAt',
] as const satisfies readonly (keyof ContributorRow)[];

export type _ContributorKeysExhaustive = AssertExhaustive<
  Exclude<keyof ContributorRow, (typeof CONTRIBUTOR_KEYS)[number]>
>;
