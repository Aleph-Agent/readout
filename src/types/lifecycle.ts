import type { AssertExhaustive } from './keys.ts';

/**
 * When a runtime stops receiving security fixes.
 *
 * The dates are published years in advance and almost nobody watches them. A
 * team learns Python 3.9 went unsupported when an auditor tells them, not when
 * it happened.
 *
 * Nothing here is inferred. The dates belong to endoflife.date, are cited to
 * it, and a cycle with no announced end is reported as unannounced rather than
 * as supported for ever.
 */
export interface LifecycleRow {
  /** As endoflife.date names it: `nodejs`, `postgresql`. */
  product: string;
  /** Release line: `20`, `3.11`, `24.04`. */
  cycle: string;
  /** `YYYY-MM-DD`, or null when no end has been announced. */
  eol: string | null;
  /** True once the date has passed, or once the source says so outright. */
  ended: boolean;
  /** Latest release on this line, as reported. */
  latest: string | null;
  lts: boolean;
  /** ISO 8601 UTC of the reading. */
  observedAt: string;
}

export const LIFECYCLE_KEYS = [
  'product',
  'cycle',
  'eol',
  'ended',
  'latest',
  'lts',
  'observedAt',
] as const satisfies readonly (keyof LifecycleRow)[];

export type _LifecycleKeysExhaustive = AssertExhaustive<
  Exclude<keyof LifecycleRow, (typeof LIFECYCLE_KEYS)[number]>
>;
