import { describe, expect, it } from 'vitest';

import { summariseAdoption } from '../src/lib/adoption-summary.ts';
import type { AdoptionRow } from '../src/types/adoption.ts';

/**
 * One arithmetic decision lives here and it is the kind that produces a
 * plausible, wrong headline: which windows may be added together.
 */

function row(over: Partial<AdoptionRow> = {}): AdoptionRow {
  return {
    id: 'a/one',
    registry: 'npm',
    name: 'one',
    count: 100,
    window: 'week',
    samples: [],
    ...over,
  };
}

describe('the weekly total', () => {
  it('adds npm and PyPI, which both report a rolling week', () => {
    const summary = summariseAdoption([
      row({ registry: 'npm', count: 100 }),
      row({ id: 'b/two', registry: 'pypi', name: 'two', count: 50, window: 'week' }),
    ]);

    expect(summary.weekly).toBe(150);
    expect(summary.weeklyPackages).toBe(2);
  });

  it('never folds in a month or a quarter', () => {
    // Homebrew reports 30 days and crates.io 90. Adding either to a weekly
    // figure produces a number that is not a week, not a month, and comparable
    // to neither — and it would sit at the top of the page in 54pt type.
    const summary = summariseAdoption([
      row({ registry: 'npm', count: 100 }),
      row({ id: 'b/two', registry: 'brew', name: 'two', count: 9000, window: '30d' }),
      row({ id: 'c/three', registry: 'crates', name: 'three', count: 9000, window: '90d' }),
    ]);

    expect(summary.weekly).toBe(100);
    expect(summary.weeklyPackages).toBe(1);
    // They still appear in the table, with their own window.
    expect(summary.measured).toBe(3);
  });

  it('counts an unreadable package as unread, never as zero', () => {
    const summary = summariseAdoption([row({ count: null }), row({ id: 'b/two', count: 5 })]);

    expect(summary.unread).toBe(1);
    expect(summary.measured).toBe(1);
    expect(summary.weekly).toBe(5);
  });

  it('ranks by count and breaks ties deterministically', () => {
    // Byte-identical output is load-bearing here: a wobbling order would make
    // every build deploy whether or not anything moved.
    const summary = summariseAdoption([
      row({ id: 'b/two', name: 'two', count: 10 }),
      row({ id: 'a/one', name: 'one', count: 10 }),
      row({ id: 'c/three', name: 'three', count: 99 }),
    ]);

    expect(summary.top.map((reading) => reading.repo)).toEqual(['c/three', 'a/one', 'b/two']);
  });

  it('has nothing to say about nothing', () => {
    const summary = summariseAdoption([]);
    expect(summary).toEqual({ measured: 0, unread: 0, weekly: 0, weeklyPackages: 0, top: [] });
  });
});
