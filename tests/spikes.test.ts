import { describe, expect, it } from 'vitest';

import {
  baselineFromHistory,
  classifySpike,
  DEFAULT_THRESHOLDS,
  type DailyForkCount,
  type SpikeObservation,
} from '../src/lib/spikes.ts';

const TODAY = '2026-08-04';

function daysAgo(n: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** `days` consecutive snapshots ending yesterday, growing by `perDay`. */
function makeHistory(days: number, perDay: number, start = 100): DailyForkCount[] {
  const rows: DailyForkCount[] = [];
  for (let i = days; i >= 1; i -= 1) {
    rows.push({ date: daysAgo(i), forks: start + (days - i) * perDay });
  }
  return rows;
}

/** Baseline of 2 forks/day, a full 24-hour window, and no movement in it. */
function observe(over: Partial<SpikeObservation> = {}): SpikeObservation {
  return {
    repo: 'owner/repo',
    history: makeHistory(20, 2),
    currentForks: 200,
    observedAt: '2026-08-04T12:00:00Z',
    windowStartForks: 200,
    windowStartAt: '2026-08-03T12:00:00Z',
    previousDetectionDate: null,
    today: TODAY,
    ...over,
  };
}

describe('baselineFromHistory', () => {
  it('averages daily fork additions', () => {
    const baseline = baselineFromHistory(makeHistory(20, 2), TODAY);
    expect(baseline.perDay).toBeCloseTo(2, 6);
    expect(baseline.days).toBe(19);
  });

  it('spreads a skipped day over the gap it covered', () => {
    // A missed daily run must not read as one enormous surge.
    const history: DailyForkCount[] = [
      { date: daysAgo(4), forks: 100 },
      { date: daysAgo(2), forks: 108 },
      { date: daysAgo(1), forks: 112 },
    ];
    const baseline = baselineFromHistory(history, TODAY);
    expect(baseline.days).toBe(3);
    expect(baseline.perDay).toBeCloseTo(4, 6);
  });

  it('clamps deleted forks to zero rather than crediting negative growth', () => {
    const history: DailyForkCount[] = [
      { date: daysAgo(3), forks: 100 },
      { date: daysAgo(2), forks: 90 },
      { date: daysAgo(1), forks: 100 },
    ];
    expect(baselineFromHistory(history, TODAY).perDay).toBeCloseTo(5, 6);
  });

  it('ignores snapshots older than the baseline window', () => {
    const history = [{ date: daysAgo(90), forks: 1 }, ...makeHistory(20, 2)];
    expect(baselineFromHistory(history, TODAY).days).toBe(19);
  });

  it('reports nothing from a single snapshot', () => {
    expect(baselineFromHistory([{ date: daysAgo(1), forks: 10 }], TODAY)).toEqual({
      perDay: null,
      days: 0,
    });
  });
});

describe('classifySpike guards', () => {
  it('returns forming with only 10 days of history', () => {
    const verdict = classifySpike(observe({ history: makeHistory(10, 2) }));
    expect(verdict.state).toBe('forming');
    expect(verdict.baselineDays).toBeLessThan(DEFAULT_THRESHOLDS.minBaselineDays);
  });

  it('returns forming with no history at all', () => {
    expect(classifySpike(observe({ history: [] })).state).toBe('forming');
  });

  it('returns forming when there is no observation window yet', () => {
    const verdict = classifySpike(observe({ windowStartForks: null, windowStartAt: null }));
    expect(verdict.state).toBe('forming');
    expect(verdict.reason).toMatch(/no observation window/);
  });

  it('returns forming when the window is shorter than a day', () => {
    const verdict = classifySpike(
      observe({ windowStartAt: '2026-08-04T02:00:00Z', currentForks: 400 }),
    );
    expect(verdict.state).toBe('forming');
    expect(verdict.reason).toMatch(/needs 24h/);
  });

  it('does NOT call 1 fork becoming 12 a spike', () => {
    // 12x on paper and meaningless in practice. The absolute floor runs before
    // any multiplier is computed, which is the whole point of it.
    const verdict = classifySpike(
      observe({
        history: makeHistory(20, 0, 1),
        currentForks: 12,
        windowStartForks: 1,
      }),
    );
    expect(verdict.state).toBe('quiet');
    expect(verdict.delta).toBe(11);
    expect(verdict.multiplier).toBeNull();
  });

  it('stays quiet when growth is large but ordinary for the repository', () => {
    // 40 added against a 30/day baseline is 1.3x — a busy repository being busy.
    const verdict = classifySpike(
      observe({ history: makeHistory(20, 30), currentForks: 240, windowStartForks: 200 }),
    );
    expect(verdict.state).toBe('quiet');
    expect(verdict.multiplier).toBeCloseTo(40 / 30, 4);
  });
});

describe('classifySpike detection', () => {
  it('detects a genuine spike on first observation', () => {
    const verdict = classifySpike(observe({ currentForks: 260, windowStartForks: 200 }));
    expect(verdict.state).toBe('detected');
    expect(verdict.delta).toBe(60);
    expect(verdict.windowHours).toBe(24);
    expect(verdict.expectedForWindow).toBeCloseTo(2, 6);
    expect(verdict.multiplier).toBeCloseTo(30, 6);
  });

  it('scales the baseline to the real window rather than assuming 24 hours', () => {
    const verdict = classifySpike(
      observe({
        currentForks: 260,
        windowStartForks: 200,
        windowStartAt: '2026-08-03T00:00:00Z', // 36 hours
      }),
    );
    expect(verdict.windowHours).toBe(36);
    expect(verdict.expectedForWindow).toBeCloseTo(3, 6);
    expect(verdict.multiplier).toBeCloseTo(20, 6);
  });

  it('confirms only after persisting into a second daily snapshot', () => {
    const verdict = classifySpike(
      observe({ currentForks: 260, windowStartForks: 200, previousDetectionDate: daysAgo(1) }),
    );
    expect(verdict.state).toBe('confirmed');
  });

  it('tolerates one skipped daily run before resetting a spike', () => {
    const verdict = classifySpike(
      observe({ currentForks: 260, windowStartForks: 200, previousDetectionDate: daysAgo(2) }),
    );
    expect(verdict.state).toBe('confirmed');
  });

  it('does not confirm from a stale detection weeks earlier', () => {
    const verdict = classifySpike(
      observe({ currentForks: 260, windowStartForks: 200, previousDetectionDate: daysAgo(9) }),
    );
    expect(verdict.state).toBe('detected');
  });

  it('bounds the displayed multiplier without hiding the real one', () => {
    const verdict = classifySpike(observe({ currentForks: 400, windowStartForks: 200 }));
    expect(verdict.multiplier).toBeCloseTo(100, 6);
    expect(verdict.displayMultiplier).toBe(DEFAULT_THRESHOLDS.displayCap);
    expect(verdict.multiplierCapped).toBe(true);
  });

  it('handles a zero baseline without dividing by zero into a number', () => {
    const verdict = classifySpike(
      observe({ history: makeHistory(20, 0), currentForks: 130, windowStartForks: 100 }),
    );
    expect(verdict.state).toBe('detected');
    expect(verdict.multiplier).toBe(Infinity);
    expect(verdict.displayMultiplier).toBe(DEFAULT_THRESHOLDS.displayCap);
    expect(verdict.multiplierCapped).toBe(true);
  });

  it('still applies the floor when the baseline is zero', () => {
    // Without this, every dormant repository that catches one mention becomes
    // an infinite multiplier and a headline.
    const verdict = classifySpike(
      observe({ history: makeHistory(20, 0), currentForks: 110, windowStartForks: 100 }),
    );
    expect(verdict.state).toBe('quiet');
  });
});
