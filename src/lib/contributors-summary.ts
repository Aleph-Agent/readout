import type { ContributorRow } from '../types/contributors.ts';

/**
 * Where the commit history is concentrated.
 *
 * The reading nobody publishes, and the one with the sharpest caveat: a low bus
 * factor is a statement about a distribution, not about a person. Every figure
 * here has to travel with what commit counts do and do not capture.
 */

export interface ConcentrationReading {
  repo: string;
  busFactor: number;
  /** As a percentage, to one decimal. */
  topShare: number;
  contributors: number;
  commits: number;
  truncated: boolean;
}

export interface ContributorSummary {
  /** Repositories with enough commits to have a shape at all. */
  measured: number;
  /** Of those, how many rest half their history on one person. */
  singleAuthor: number;
  /** Median bus factor across `measured`. */
  medianBusFactor: number | null;
  /** Most concentrated first. Bounded — see `LIMIT`. */
  concentrated: ConcentrationReading[];
}

export const LIMIT = 15;

export function summariseContributors(rows: readonly ContributorRow[]): ContributorSummary {
  if (rows.length === 0) {
    return { measured: 0, singleAuthor: 0, medianBusFactor: null, concentrated: [] };
  }

  const factors = rows.map((row) => row.busFactor).sort((a, b) => a - b);
  const middle = Math.floor(factors.length / 2);

  const readings: ConcentrationReading[] = rows.map((row) => ({
    repo: row.id,
    busFactor: row.busFactor,
    topShare: Math.round(row.topShare * 1000) / 10,
    contributors: row.contributors,
    commits: row.commits,
    truncated: row.truncated,
  }));

  return {
    measured: rows.length,
    singleAuthor: rows.filter((row) => row.busFactor === 1).length,
    medianBusFactor:
      factors.length % 2 === 0
        ? Math.round((((factors[middle - 1] as number) + (factors[middle] as number)) / 2) * 10) / 10
        : (factors[middle] as number),
    concentrated: readings
      .sort((a, b) => a.busFactor - b.busFactor || b.topShare - a.topShare)
      .slice(0, LIMIT),
  };
}
