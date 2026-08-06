import type { AssertExhaustive } from './keys.ts';

/**
 * What other people's analysis says about a watched project.
 *
 * Everything else here is either GitHub's own numbers or a registry's own
 * counts. This is the first reading that is somebody else's assessment: the
 * OpenSSF Scorecard, computed by Google's Open Source Insights from the
 * repository's actual practices, and the advisories filed against the packages
 * a repository publishes.
 *
 * Neither is a judgement this project makes. Both are cited, and both link back
 * to the body that made them — which is the only way a claim about somebody
 * else's security posture is defensible.
 */

export interface HealthRow {
  /** Watchlist repository id. */
  id: string;
  /**
   * OpenSSF Scorecard overall, 0–10. Null when the project has never been
   * scanned, which is a different fact from scoring zero and must not render
   * as one.
   */
  scorecard: number | null;
  /** `YYYY-MM-DD` the scorecard was generated, as reported by deps.dev. */
  scoredAt: string | null;
  /**
   * Advisories filed against the packages this repository publishes, all time.
   *
   * Null when the repository publishes nothing this project can look up, which
   * is most of them. Zero means looked up and none found.
   */
  advisories: number | null;
  /** ISO 8601 UTC of the reading. */
  observedAt: string;
}

export const HEALTH_KEYS = [
  'id',
  'scorecard',
  'scoredAt',
  'advisories',
  'observedAt',
] as const satisfies readonly (keyof HealthRow)[];

export type _HealthKeysExhaustive = AssertExhaustive<
  Exclude<keyof HealthRow, (typeof HEALTH_KEYS)[number]>
>;
