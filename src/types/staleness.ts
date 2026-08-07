import type { AssertExhaustive } from './keys.ts';

/**
 * When a package was last actually published, according to its registry.
 *
 * Distinct from anything GitHub says, and the two disagree more often than
 * people expect. A repository can have commits this week and a package nobody
 * has shipped in two years — the commits are what a maintainer does for
 * themselves, the publish is what reaches the people depending on it.
 */
export interface StalenessRow {
  registry: string;
  name: string;
  /** Watched repository this package belongs to, for the link back. */
  repo: string;
  /** ISO 8601 date of the newest published version, or null when unreadable. */
  lastPublish: string | null;
  /** The version that date belongs to. */
  version: string | null;
  observedAt: string;
}

export const STALENESS_KEYS = [
  'registry',
  'name',
  'repo',
  'lastPublish',
  'version',
  'observedAt',
] as const satisfies readonly (keyof StalenessRow)[];

export type _StalenessKeysExhaustive = AssertExhaustive<
  Exclude<keyof StalenessRow, (typeof STALENESS_KEYS)[number]>
>;
