import type { AssertExhaustive } from './keys.ts';

/**
 * A package name one edit away from a package people install.
 *
 * The row asserts exactly that and nothing more. It is not a claim that the
 * package is malicious, and anything rendering it must not imply one — near
 * names are routinely forks, ports, translations, or somebody's abandoned first
 * attempt, and calling one of those malicious in public would be defamation
 * with a build step.
 */
export interface TyposquatRow {
  /** The real package, as spelled by the project that publishes it. */
  canonical: string;
  /** The neighbouring name that also exists on the registry. */
  name: string;
  /** Edit distance from `canonical`. Only 1 is ever recorded. */
  distance: number;
  /** When the neighbour last published, as the registry reports it. */
  lastPublish: string;
  observedAt: string;
}

export const TYPOSQUAT_KEYS = [
  'canonical',
  'name',
  'distance',
  'lastPublish',
  'observedAt',
] as const satisfies readonly (keyof TyposquatRow)[];

export type _TyposquatKeysExhaustive = AssertExhaustive<
  Exclude<keyof TyposquatRow, (typeof TYPOSQUAT_KEYS)[number]>
>;
