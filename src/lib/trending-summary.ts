import type { TrendingRow } from '../types/trending.ts';

/**
 * Rising projects, ordered by the question a trending list cannot answer.
 *
 * Not by momentum — OSSInsight already ranks by that and does it better. The
 * ordering here is by concentration, because the reason to put these two
 * numbers side by side is the case where they disagree: something gaining
 * thousands of stars a quarter that one person wrote all of.
 */

export interface RisingReading {
  id: string;
  language: string;
  starsGained: number;
  busFactor: number | null;
  /** Largest contributor's share as a percentage, or null when unread. */
  topShare: number | null;
}

export interface TrendingSummary {
  /** `YYYY-MM-DD` of the newest read, or null before the first. */
  readAt: string | null;
  /** Projects in that read. */
  projects: number;
  /** Of those, how many have a contributor reading at all. */
  measured: number;
  /** Of the measured, how many rest half their commits on one person. */
  singleAuthor: number;
  /** Most concentrated first, then by momentum. */
  rising: RisingReading[];
}

export const LIMIT = 20;

export function summariseTrending(rows: readonly TrendingRow[]): TrendingSummary {
  const readAt = rows.reduce<string | null>(
    (newest, row) => (newest === null || row.readAt > newest ? row.readAt : newest),
    null,
  );

  if (readAt === null) {
    return { readAt: null, projects: 0, measured: 0, singleAuthor: 0, rising: [] };
  }

  const current = rows.filter((row) => row.readAt === readAt);
  const measured = current.filter((row) => row.busFactor !== null);

  return {
    readAt,
    projects: current.length,
    measured: measured.length,
    singleAuthor: measured.filter((row) => row.busFactor === 1).length,
    rising: [...current]
      .sort((a, b) => {
        // Unread sorts last. It is not a low bus factor and must not lead a
        // table whose whole point is which projects rest on one person.
        const left = a.busFactor ?? Number.POSITIVE_INFINITY;
        const right = b.busFactor ?? Number.POSITIVE_INFINITY;
        return left - right || b.starsGained - a.starsGained;
      })
      .slice(0, LIMIT)
      .map((row) => ({
        id: row.id,
        language: row.language,
        starsGained: row.starsGained,
        busFactor: row.busFactor,
        topShare: row.topShare === null ? null : Math.round(row.topShare * 1000) / 10,
      })),
  };
}
