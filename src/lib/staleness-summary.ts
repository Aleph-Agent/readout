import { daysSince } from '../collectors/staleness.ts';
import type { StalenessRow } from '../types/staleness.ts';

/**
 * How long ago each package actually shipped.
 *
 * The comparison the page exists to make is between this and the repository's
 * last push, which is the field every "is this maintained" badge reads. They
 * come apart constantly, and the direction matters: commits without releases is
 * the ordinary shape of a dependency that has quietly stopped being delivered.
 */

export interface StaleReading {
  registry: string;
  name: string;
  repo: string;
  lastPublish: string;
  days: number;
  version: string | null;
}

export interface StalenessSummary {
  /** Packages with a readable publish date. Every figure rests on this. */
  measured: number;
  /** Mapped but unreadable this run. Stated, never counted as never-published. */
  unread: number;
  /** Median days since the last publish, across `measured`. */
  medianDays: number | null;
  /** Packages whose last release is over a year old. */
  overAYear: number;
  /** Longest silence first. Bounded — see `QUIETEST_LIMIT`. */
  quietest: StaleReading[];
  /** Days since the last publish, per registry, as a median. */
  byRegistry: { registry: string; measured: number; medianDays: number | null }[];
}

export const QUIETEST_LIMIT = 15;
export const A_YEAR = 365;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
    : (sorted[middle] as number);
}

export function summariseStaleness(
  rows: readonly StalenessRow[],
  today: string,
): StalenessSummary {
  const readings: StaleReading[] = [];
  let unread = 0;

  for (const row of rows) {
    if (row.lastPublish === null) {
      unread += 1;
      continue;
    }
    readings.push({
      registry: row.registry,
      name: row.name,
      repo: row.repo,
      lastPublish: row.lastPublish,
      days: daysSince(`${row.lastPublish}T00:00:00Z`, today),
      version: row.version,
    });
  }

  const registries = [...new Set(readings.map((reading) => reading.registry))].sort();

  return {
    measured: readings.length,
    unread,
    medianDays: median(readings.map((reading) => reading.days)),
    overAYear: readings.filter((reading) => reading.days > A_YEAR).length,
    quietest: [...readings]
      .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name))
      .slice(0, QUIETEST_LIMIT),
    byRegistry: registries.map((registry) => {
      const mine = readings.filter((reading) => reading.registry === registry);
      return {
        registry,
        measured: mine.length,
        medianDays: median(mine.map((reading) => reading.days)),
      };
    }),
  };
}
