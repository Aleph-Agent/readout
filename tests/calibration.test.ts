import { describe, expect, it } from 'vitest';

import {
  REACHABLE_SHARE,
  summariseCalibration,
  summariseWindow,
  type CalibrationRow,
} from '../src/lib/calibration.ts';

/**
 * The instrument that measures the instrument.
 *
 * Everything else here records what crossed a threshold. This records what did
 * not, because a detector set above anything that happens in the real world
 * produces exactly the same empty page as a quiet month — and after thirty days
 * of silence there is no way to tell them apart unless the near-misses were
 * written down at the time.
 */

const DAY = '2026-08-06';

function summarise(values: readonly number[], threshold = 3): CalibrationRow {
  return summariseCalibration(DAY, 'fork-spike', 'multiplier', threshold, values);
}

describe('one day against one threshold', () => {
  it('records the sample, the crossings and how close the rest got', () => {
    const row = summarise([0.5, 1, 1.5, 2, 4]);

    expect(row.measured).toBe(5);
    expect(row.crossed).toBe(1);
    expect(row.max).toBe(4);
    expect(row.p50).toBe(1.5);
  });

  it('distinguishes nothing measured from nothing crossed', () => {
    // The two states a detector can be in that both produce no events. They
    // are not the same claim and the record must not flatten them.
    const nothing = summarise([]);
    expect(nothing.measured).toBe(0);
    expect(nothing.max).toBeNull();
    expect(nothing.p50).toBeNull();

    const quiet = summarise([0.2, 0.4]);
    expect(quiet.measured).toBe(2);
    expect(quiet.crossed).toBe(0);
    expect(quiet.max).toBe(0.4);
  });

  it('counts an unbounded reading as a crossing but not as a magnitude', () => {
    // A multiplier over a zero baseline is infinite. It did cross, but it is a
    // division artefact rather than a measurement, and reporting it as the
    // maximum would hide every real reading underneath it.
    const row = summarise([1, 2, Number.POSITIVE_INFINITY]);

    expect(row.crossed).toBe(1);
    expect(row.unbounded).toBe(1);
    expect(row.max).toBe(2);
  });

  it('reports percentiles that something actually produced', () => {
    // Nearest-rank, not interpolated. An interpolated percentile is a number
    // no repository ever produced, and this file exists to stop the project
    // inventing figures.
    const row = summarise([1, 2, 3, 4]);
    expect([1, 2, 3, 4]).toContain(row.p50);
    expect([1, 2, 3, 4]).toContain(row.p90);
  });
});

describe('a window of days', () => {
  function row(date: string, max: number | null, crossed = 0, measured = 10): CalibrationRow {
    return {
      date,
      collector: 'fork-spike',
      metric: 'multiplier',
      threshold: 8,
      measured,
      crossed,
      max,
      p50: max,
      p90: max,
      p99: max,
      unbounded: 0,
    };
  }

  it('carries the peak across the whole window, not the last day', () => {
    const summary = summariseWindow([row('2026-08-01', 6), row('2026-08-02', 1)], 'fork-spike');

    expect(summary?.peak).toBe(6);
    expect(summary?.days).toBe(2);
    expect(summary?.measured).toBe(20);
  });

  it('states the peak as a share of the bar, which is the whole point', () => {
    // "The highest reading in thirty days was 2 and the bar is 8" is a sentence
    // about the instrument. It is the only sentence that says whether the
    // instrument can see what it claims to look for.
    const summary = summariseWindow([row('2026-08-01', 2)], 'fork-spike');

    expect(summary?.peakShare).toBe(0.25);
    expect(summary?.peakShare as number).toBeLessThan(REACHABLE_SHARE);
  });

  it('has nothing to say about a collector with no rows', () => {
    expect(summariseWindow([row('2026-08-01', 2)], 'lineage')).toBeNull();
  });

  it('reports no peak when every crossing was unbounded', () => {
    // Crossings exist and no magnitude does. Reporting a peak of zero here
    // would read as "nothing came close" while findings were being published.
    const unbounded: CalibrationRow = { ...row('2026-08-01', null, 3), unbounded: 3 };
    const summary = summariseWindow([unbounded], 'fork-spike');

    expect(summary?.crossed).toBe(3);
    expect(summary?.peak).toBeNull();
    expect(summary?.peakShare).toBeNull();
  });
});
