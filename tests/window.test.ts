import { describe, expect, it } from 'vitest';

import { pruneSamples, recordSample, windowAnchor } from '../src/lib/window.ts';
import type { ForkSample } from '../src/types/window.ts';

const HOUR = 3_600_000;
const BASE = Date.parse('2026-08-04T12:00:00Z');

function at(hoursAgo: number): string {
  return new Date(BASE - hoursAgo * HOUR).toISOString();
}

describe('recordSample', () => {
  it('appends when the fork count moved', () => {
    const samples = recordSample([{ at: at(4), forks: 100 }], at(0), 105);
    expect(samples).toHaveLength(2);
    expect(samples.at(-1)).toEqual({ at: at(0), forks: 105 });
  });

  it('appends nothing when the count is unchanged and the anchor is fresh', () => {
    // A dormant repository must contribute no diff at all. Churn should track
    // real activity, not pulse frequency.
    const existing: ForkSample[] = [{ at: at(4), forks: 100 }];
    expect(recordSample(existing, at(0), 100)).toEqual(existing);
  });

  it('appends an unchanged count once the anchor ages past the window', () => {
    // Otherwise a repository dormant for a week and then spiking gets measured
    // against a week-old anchor, diluting the spike across seven days.
    const samples = recordSample([{ at: at(30), forks: 100 }], at(0), 100);
    expect(samples).toHaveLength(2);
  });

  it('starts a history from nothing', () => {
    expect(recordSample([], at(0), 100)).toEqual([{ at: at(0), forks: 100 }]);
  });

  it('rejects a timestamp it cannot parse', () => {
    expect(() => recordSample([], 'yesterday', 100)).toThrow(/not an ISO timestamp/);
  });
});

describe('pruneSamples', () => {
  it('drops everything older than the anchor', () => {
    const samples: ForkSample[] = [
      { at: at(72), forks: 80 },
      { at: at(48), forks: 90 },
      { at: at(26), forks: 95 },
      { at: at(4), forks: 100 },
    ];
    const pruned = pruneSamples(samples, BASE);
    expect(pruned.map((s) => s.forks)).toEqual([95, 100]);
  });

  it('keeps everything while the window is still filling', () => {
    const samples: ForkSample[] = [
      { at: at(8), forks: 90 },
      { at: at(4), forks: 100 },
    ];
    expect(pruneSamples(samples, BASE)).toEqual(samples);
  });

  it('never empties the history', () => {
    expect(pruneSamples([{ at: at(200), forks: 1 }], BASE)).toHaveLength(1);
  });
});

describe('windowAnchor', () => {
  it('returns the newest sample at least a day old', () => {
    const samples: ForkSample[] = [
      { at: at(48), forks: 80 },
      { at: at(26), forks: 95 },
      { at: at(4), forks: 100 },
    ];
    expect(windowAnchor(samples, BASE)?.forks).toBe(95);
  });

  it('returns null while the window is still filling', () => {
    // Reported as `forming` rather than papered over with the oldest reading.
    expect(windowAnchor([{ at: at(6), forks: 100 }], BASE)).toBeNull();
  });

  it('returns null with no samples', () => {
    expect(windowAnchor([], BASE)).toBeNull();
  });
});
