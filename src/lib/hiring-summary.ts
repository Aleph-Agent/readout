import type { HiringRow } from '../types/hiring.ts';

/**
 * What employers asked for, and what changed since last month.
 *
 * The share matters more than the count: a thread with 284 posts and one with
 * 434 cannot be compared on raw numbers, and comparing them anyway is the
 * easiest way to publish a trend that is really just a slower month.
 */

export interface HiringReading {
  term: string;
  posts: number;
  /** Posts naming it, as a share of the thread. Rounded to a tenth of a point. */
  share: number;
  /** Percentage points against the previous month, or null with nothing to compare. */
  move: number | null;
  conservative: boolean;
}

export interface HiringSummary {
  /** `YYYY-MM` of the newest thread read, or null before the first read. */
  month: string | null;
  /** Job posts in that thread. Every figure below rests on this. */
  sample: number;
  /** The month being compared against, or null. */
  previousMonth: string | null;
  previousSample: number;
  /** Most-named first. Bounded — see `TOP_LIMIT`. */
  top: HiringReading[];
  /** Largest gains in share, then largest falls. Only where both months exist. */
  rising: HiringReading[];
  falling: HiringReading[];
}

export const TOP_LIMIT = 20;
export const MOVERS_LIMIT = 6;

/** Below this a swing is noise in a few-hundred-post sample, not a movement. */
export const MIN_MOVE = 1.5;

function share(posts: number, sample: number): number {
  return sample === 0 ? 0 : Math.round((posts / sample) * 1000) / 10;
}

export function summariseHiring(rows: readonly HiringRow[]): HiringSummary {
  const months = [...new Set(rows.map((row) => row.month))].sort().reverse();
  const month = months[0] ?? null;
  const previousMonth = months[1] ?? null;

  if (month === null) {
    return {
      month: null,
      sample: 0,
      previousMonth: null,
      previousSample: 0,
      top: [],
      rising: [],
      falling: [],
    };
  }

  const current = rows.filter((row) => row.month === month);
  const before = new Map(
    rows.filter((row) => row.month === previousMonth).map((row) => [row.term, row]),
  );

  const sample = current[0]?.sample ?? 0;
  const previousSample = previousMonth === null ? 0 : ([...before.values()][0]?.sample ?? 0);

  const readings: HiringReading[] = current
    .map((row) => {
      const was = before.get(row.term);
      const nowShare = share(row.posts, row.sample);
      return {
        term: row.term,
        posts: row.posts,
        share: nowShare,
        // Points of share, not of count. A term can be named by more posts in a
        // bigger thread while being asked for less often.
        move:
          was === undefined
            ? null
            : Math.round((nowShare - share(was.posts, was.sample)) * 10) / 10,
        conservative: row.conservative,
      };
    })
    .sort((a, b) => b.posts - a.posts || a.term.localeCompare(b.term));

  const moved = readings.filter(
    (reading) => reading.move !== null && Math.abs(reading.move) >= MIN_MOVE,
  );

  return {
    month,
    sample,
    previousMonth,
    previousSample,
    top: readings.slice(0, TOP_LIMIT),
    rising: [...moved]
      .sort((a, b) => (b.move as number) - (a.move as number))
      .filter((reading) => (reading.move as number) > 0)
      .slice(0, MOVERS_LIMIT),
    falling: [...moved]
      .sort((a, b) => (a.move as number) - (b.move as number))
      .filter((reading) => (reading.move as number) < 0)
      .slice(0, MOVERS_LIMIT),
  };
}
