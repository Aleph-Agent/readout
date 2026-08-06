/**
 * Whether the bar can be reached at all.
 *
 * Every collector here answers a yes-or-no question — did this cross the
 * threshold — and until now the answer to "no" was discarded. That leaves the
 * project unable to distinguish two situations that look identical from
 * outside:
 *
 *   1. Nothing crossed the bar because nothing happened.
 *   2. Nothing crossed the bar because the bar is above the world.
 *
 * Both render as an empty page. After thirty silent days there would be no way
 * to tell which one had been happening, and no way to recover the evidence,
 * because the near-misses were never written down.
 *
 * So they are now. Once a day, per collector, the distribution of everything
 * measured against its threshold is recorded: how many could be compared, how
 * many crossed, and how close the rest got. "The highest fork multiplier seen
 * in thirty days was 2.1× and the bar is 3×" is a sentence about the
 * instrument, not about open source, and it is the one sentence that says
 * whether the instrument is calibrated.
 *
 * Pure, so the summary is testable without a collector, a network, or a day.
 */

import type { AssertExhaustive } from '../types/keys.ts';

export interface CalibrationRow {
  /** `YYYY-MM-DD` UTC of the run. One row per collector per day. */
  date: string;
  collector: string;
  /** The quantity compared against the bar, named as the reader would say it. */
  metric: string;
  threshold: number;
  /** Observations that could be compared at all. The sample size. */
  measured: number;
  /** Of those, how many met or exceeded the threshold. */
  crossed: number;
  /**
   * The highest finite value seen, and the percentiles below it.
   *
   * Null when nothing was measurable. An unbounded value — a multiplier over a
   * zero baseline is infinite — is counted as a crossing but excluded from
   * these, because it is a division artefact rather than a magnitude and
   * reporting it as the maximum would hide every real reading beneath it.
   */
  max: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  /** Observations whose value was not finite. Stated rather than hidden. */
  unbounded: number;
}

/** Two decimals. Enough to see a bar being approached, stable in a git diff. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Nearest-rank percentile.
 *
 * Not interpolated on purpose: every value here is an observation that actually
 * happened, and an interpolated percentile is a number no repository ever
 * produced. This file exists to stop the project inventing figures.
 */
function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return round(sorted[index] as number);
}

export function summariseCalibration(
  date: string,
  collector: string,
  metric: string,
  threshold: number,
  values: readonly number[],
): CalibrationRow {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const unbounded = values.length - finite.length;

  return {
    date,
    collector,
    metric,
    threshold,
    measured: values.length,
    // Unbounded values crossed anything. Counting them here and excluding them
    // from the percentiles is the honest split.
    crossed: values.filter((value) => !Number.isFinite(value) || value >= threshold).length,
    max: finite.length === 0 ? null : round(finite[finite.length - 1] as number),
    p50: percentile(finite, 0.5),
    p90: percentile(finite, 0.9),
    p99: percentile(finite, 0.99),
    unbounded,
  };
}

export const CALIBRATION_KEYS = [
  'date',
  'collector',
  'metric',
  'threshold',
  'measured',
  'crossed',
  'max',
  'p50',
  'p90',
  'p99',
  'unbounded',
] as const satisfies readonly (keyof CalibrationRow)[];

/**
 * `satisfies` only catches a key that does not exist on the row. This catches
 * the other direction — a field added to `CalibrationRow` and forgotten here,
 * which would be silently dropped on write. Every other record in the project
 * has this guard and this one did not.
 */
export type _CalibrationKeysExhaustive = AssertExhaustive<
  Exclude<keyof CalibrationRow, (typeof CALIBRATION_KEYS)[number]>
>;

/**
 * What a reader needs to know about one collector, over a window of days.
 *
 * The headline is `reachable`: whether anything in the window got within reach
 * of the bar. A collector that has never produced a value above a fraction of
 * its own threshold is not quiet — it is misconfigured, and this is what says
 * so out loud.
 */
export interface CalibrationSummary {
  collector: string;
  metric: string;
  threshold: number;
  days: number;
  measured: number;
  crossed: number;
  /** Highest single value across the window. Null when nothing was measurable. */
  peak: number | null;
  /** Peak as a share of the threshold. Null when there is no peak. */
  peakShare: number | null;
}

/** Anything below this share of the bar, across the whole window, is a warning. */
export const REACHABLE_SHARE = 0.5;

export function summariseWindow(
  rows: readonly CalibrationRow[],
  collector: string,
): CalibrationSummary | null {
  const mine = rows.filter((row) => row.collector === collector);
  const first = mine[0];
  if (first === undefined) return null;

  const peaks = mine.map((row) => row.max).filter((max): max is number => max !== null);
  const peak = peaks.length === 0 ? null : Math.max(...peaks);
  const unbounded = mine.reduce((total, row) => total + row.unbounded, 0);

  return {
    collector,
    metric: first.metric,
    threshold: first.threshold,
    days: mine.length,
    measured: mine.reduce((total, row) => total + row.measured, 0),
    crossed: mine.reduce((total, row) => total + row.crossed, 0),
    // An unbounded reading is a crossing but not a magnitude, so it cannot set
    // the peak. Saying "no peak" while crossings exist is the accurate shape.
    peak: peak === null && unbounded > 0 ? null : peak,
    peakShare: peak === null || first.threshold === 0 ? null : round(peak / first.threshold),
  };
}
