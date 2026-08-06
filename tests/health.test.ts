import { describe, expect, it } from 'vitest';

import { collectHealth, type HealthClient } from '../src/collectors/health.ts';
import { summariseHealth } from '../src/lib/health-summary.ts';
import type { HealthRow } from '../src/types/health.ts';
import type { WatchlistEntry } from '../src/types/watchlist.ts';

/**
 * The first reading here that is somebody else's assessment rather than a count
 * this project took. That makes it the most dangerous one to get wrong: a low
 * score is a public claim about another team's engineering practices.
 */

const NOW = '2026-08-06T02:17:00.000Z';

function entry(id: string, packages: string[] = [], active = true): WatchlistEntry {
  return { id, category: 'devtool', added: '2026-07-01', active, packages };
}

function row(id: string, scorecard: number | null, advisories: number | null = null): HealthRow {
  return { id, scorecard, scoredAt: '2026-08-01', advisories, observedAt: NOW };
}

function stub(over: Partial<HealthClient> = {}): HealthClient {
  return {
    scorecard: async () => null,
    advisories: async () => new Map(),
    requests: () => 0,
    ...over,
  };
}

describe('collecting', () => {
  it('reads a score and the date it was generated', async () => {
    const result = await collectHealth([entry('a/one')], {
      now: NOW,
      delayMs: 0,
      client: stub({ scorecard: async () => ({ score: 7.2, at: '2026-08-01' }) }),
    });

    expect(result.rows[0]?.scorecard).toBe(7.2);
    expect(result.rows[0]?.scoredAt).toBe('2026-08-01');
  });

  it('leaves an unscanned project unscored rather than scoring it zero', async () => {
    // Most of the watchlist has never been scanned. Zero would be a claim.
    const result = await collectHealth([entry('a/one')], { now: NOW, delayMs: 0, client: stub() });
    expect(result.rows[0]?.scorecard).toBeNull();
  });

  it('sums advisories across every package a repository publishes', async () => {
    const result = await collectHealth([entry('a/one', ['npm:one', 'pypi:uno'])], {
      now: NOW,
      delayMs: 0,
      client: stub({
        advisories: async () =>
          new Map([
            ['npm/one', 3],
            ['PyPI/uno', 4],
          ]),
      }),
    });

    expect(result.rows[0]?.advisories).toBe(7);
  });

  it('does not ask OSV about Homebrew, which it does not track', async () => {
    let asked: unknown[] = [];
    await collectHealth([entry('a/one', ['brew:one'])], {
      now: NOW,
      delayMs: 0,
      client: stub({
        advisories: async (packages) => {
          asked = [...packages];
          return new Map();
        },
      }),
    });

    expect(asked).toHaveLength(0);
  });

  it('spends nothing on a retired repository', async () => {
    let asked = 0;
    const result = await collectHealth([entry('a/one', [], false)], {
      now: NOW,
      delayMs: 0,
      client: stub({
        scorecard: async () => {
          asked += 1;
          return null;
        },
      }),
    });

    expect(asked).toBe(0);
    expect(result.rows).toHaveLength(0);
  });
});

describe('summarising', () => {
  it('names only projects that were actually scanned', () => {
    // Sorting unscanned repositories to the bottom of a list ordered by score
    // would publish "worst security practices" about projects nobody assessed.
    // That is the single worst claim available here and it would look real.
    const summary = summariseHealth([row('a/one', 2.1), row('b/two', null), row('c/three', 8.4)]);

    expect(summary.weakest.map((reading) => reading.repo)).toEqual(['a/one', 'c/three']);
    expect(summary.scored).toBe(2);
    expect(summary.unscored).toBe(1);
  });

  it('takes the median of the scanned, never of the whole watchlist', () => {
    const summary = summariseHealth([
      row('a/one', 2),
      row('b/two', 6),
      row('c/three', 8),
      row('d/four', null),
    ]);
    expect(summary.median).toBe(6);
  });

  it('has no median when nothing is scored', () => {
    expect(summariseHealth([row('a/one', null)]).median).toBeNull();
  });

  it('counts advisories across everything, scored or not', () => {
    // A repository can carry advisories without ever having been scorecarded.
    const summary = summariseHealth([row('a/one', null, 5), row('b/two', 7, 2)]);
    expect(summary.advisories).toBe(7);
  });

  it('orders weakest first, because any other order buries the finding', () => {
    const summary = summariseHealth([row('a/one', 9), row('b/two', 1), row('c/three', 5)]);
    expect(summary.weakest.map((reading) => reading.scorecard)).toEqual([1, 5, 9]);
  });
});
