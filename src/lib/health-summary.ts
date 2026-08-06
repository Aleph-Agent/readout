/**
 * Health, reduced to what the page needs.
 *
 * Pure, so the two decisions that could mislead — what counts as unscored, and
 * which projects are worth naming — are testable rather than buried in a build.
 */

import type { HealthReading, HealthSummary } from '../types/bundles.ts';
import type { HealthRow } from '../types/health.ts';

/** Enough to be a finding, few enough that it is not a shaming list. */
const WEAKEST = 12;

/**
 * Only projects that were actually scanned can be called weak.
 *
 * A repository OpenSSF has never looked at has no score, and putting it at the
 * bottom of a list ordered by score would publish "worst security practices"
 * about a project nobody assessed. That is the single worst claim available
 * here and it would look exactly like a real reading.
 */
export function summariseHealth(rows: readonly HealthRow[]): HealthSummary {
  const scored = rows.filter(
    (row): row is HealthRow & { scorecard: number } => row.scorecard !== null,
  );

  const sorted = [...scored].map((row) => row.scorecard).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? (sorted[middle] as number)
        : Math.round((((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2) * 10) /
          10;

  const weakest: HealthReading[] = [...scored]
    .sort((a, b) => a.scorecard - b.scorecard || (a.id < b.id ? -1 : 1))
    .slice(0, WEAKEST)
    .map((row) => ({
      repo: row.id,
      scorecard: row.scorecard,
      scoredAt: row.scoredAt,
      advisories: row.advisories,
    }));

  return {
    scored: scored.length,
    unscored: rows.length - scored.length,
    median,
    advisories: rows.reduce((total, row) => total + (row.advisories ?? 0), 0),
    weakest,
  };
}
