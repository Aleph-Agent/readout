import type { QuestionRow } from '../types/questions.ts';

/**
 * Tags ranked by volume, and by which way they are moving.
 *
 * Volume has fallen across essentially every tag on Stack Overflow since
 * assistants started answering these questions instead, so a tag falling is the
 * baseline rather than the finding. What survives that is the comparison
 * between tags over the same window: a tag falling faster than the rest is
 * saying something, and a tag falling slower is saying the opposite.
 */

export interface QuestionReading {
  tag: string;
  recent: number;
  earlier: number;
  /** Percent change between the two windows. Null below the floor. */
  change: number | null;
  /** Percentage points against the median tag's change. Null with no median. */
  vsMedian: number | null;
}

export interface QuestionSummary {
  windowDays: number;
  /** Tags with a reading in both windows. */
  tags: number;
  /** Questions in the recent window across every tag. */
  total: number;
  /** The median tag's change, which is the baseline everything else is read against. */
  medianChange: number | null;
  /** Busiest first. */
  busiest: QuestionReading[];
  /** Furthest above the median first, then furthest below. */
  holding: QuestionReading[];
  fading: QuestionReading[];
}

/**
 * Below this many questions in the earlier window, a percentage is noise.
 *
 * Four to two is a fifty percent collapse and means nothing at all.
 */
export const MIN_BASE = 25;

export const LIMIT = 12;
export const MOVERS = 6;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2) * 10) / 10
    : (sorted[middle] as number);
}

export function summariseQuestions(rows: readonly QuestionRow[]): QuestionSummary {
  if (rows.length === 0) {
    return {
      windowDays: 0,
      tags: 0,
      total: 0,
      medianChange: null,
      busiest: [],
      holding: [],
      fading: [],
    };
  }

  const withChange = rows.map((row) => ({
    tag: row.tag,
    recent: row.recent,
    earlier: row.earlier,
    change:
      row.earlier < MIN_BASE
        ? null
        : Math.round(((row.recent - row.earlier) / row.earlier) * 1000) / 10,
  }));

  const medianChange = median(
    withChange.map((row) => row.change).filter((value): value is number => value !== null),
  );

  const readings: QuestionReading[] = withChange.map((row) => ({
    ...row,
    vsMedian:
      row.change === null || medianChange === null
        ? null
        : Math.round((row.change - medianChange) * 10) / 10,
  }));

  const moved = readings.filter((reading) => reading.vsMedian !== null);

  return {
    windowDays: rows[0]?.windowDays ?? 0,
    tags: rows.length,
    total: rows.reduce((sum, row) => sum + row.recent, 0),
    medianChange,
    busiest: [...readings].sort((a, b) => b.recent - a.recent).slice(0, LIMIT),
    holding: [...moved]
      .sort((a, b) => (b.vsMedian as number) - (a.vsMedian as number))
      .slice(0, MOVERS),
    fading: [...moved]
      .sort((a, b) => (a.vsMedian as number) - (b.vsMedian as number))
      .slice(0, MOVERS),
  };
}
