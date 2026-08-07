import { describe, expect, it } from 'vitest';

import { collectTrending, MIN_GAINED, type TrendingClient } from '../src/collectors/trending.ts';
import { summariseTrending } from '../src/lib/trending-summary.ts';
import type { TrendingRow } from '../src/types/trending.ts';

/**
 * Somebody else's trending list, with the column it cannot carry.
 *
 * The risk here is the opposite of everywhere else in this project: not a
 * missing reading, but a confident one about a repository five days old. A bus
 * factor of one on a new project is a fact about the calendar, and printing it
 * beside a momentum score dressed as a warning would be the least defensible
 * thing on the site.
 */

const NOW = '2026-08-07T02:17:00.000Z';

function client(lists: Record<string, { id: string; starsGained: number; score: number }[] | null>): TrendingClient {
  let spent = 0;
  return {
    requests: () => spent,
    async trending(language) {
      spent += 1;
      return lists[language] ?? null;
    },
  };
}

function row(over: Partial<TrendingRow> = {}): TrendingRow {
  return {
    id: 'a/one',
    language: 'Rust',
    score: 100,
    starsGained: 1000,
    busFactor: 3,
    topShare: 0.3,
    readAt: '2026-08-07',
    observedAt: NOW,
    ...over,
  };
}

describe('collectTrending', () => {
  it('drops projects below the growth floor', async () => {
    // The weekly window is five-day-old repositories with nine stars. Reporting
    // their bus factor is reporting the calendar.
    const result = await collectTrending({
      now: NOW,
      readAt: '2026-08-07',
      delayMs: 0,
      languages: ['Rust'],
      client: client({
        Rust: [
          { id: 'real/project', starsGained: MIN_GAINED, score: 900 },
          { id: 'brand/new', starsGained: MIN_GAINED - 1, score: 800 },
        ],
      }),
    });

    expect(result.rows.map((entry) => entry.id)).toEqual(['real/project']);
  });

  it('records the list with no bus factor rather than not at all', async () => {
    // Without a GitHub client the momentum reading is still true. Refusing to
    // record it would lose a reading over a column being absent.
    const result = await collectTrending({
      now: NOW,
      readAt: '2026-08-07',
      delayMs: 0,
      languages: ['Rust'],
      client: client({ Rust: [{ id: 'a/one', starsGained: 900, score: 500 }] }),
    });

    expect(result.rows[0]).toMatchObject({ id: 'a/one', busFactor: null, topShare: null });
  });

  it('writes nothing when every language failed', async () => {
    // An empty list would read as a quarter in which nothing rose, which never
    // happens and would be false if recorded.
    const result = await collectTrending({
      now: NOW,
      readAt: '2026-08-07',
      delayMs: 0,
      languages: ['Rust', 'Go'],
      client: client({}),
    });

    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(2);
  });

  it('names the stars field for what it holds', async () => {
    // Three months of growth, not the repository total. A field called `stars`
    // holding 2,902 is a different claim about a very different project.
    const result = await collectTrending({
      now: NOW,
      readAt: '2026-08-07',
      delayMs: 0,
      languages: ['Rust'],
      client: client({ Rust: [{ id: 'a/one', starsGained: 2902, score: 1 }] }),
    });

    expect(result.rows[0]?.starsGained).toBe(2902);
  });
});

describe('summariseTrending', () => {
  it('orders by concentration, not by momentum', () => {
    // OSSInsight already ranks by momentum and does it better. The only reason
    // to put the two numbers together is the case where they disagree.
    const summary = summariseTrending([
      row({ id: 'popular/spread', starsGained: 5000, busFactor: 8 }),
      row({ id: 'quiet/solo', starsGained: 400, busFactor: 1 }),
    ]);

    expect(summary.rising.map((entry) => entry.id)).toEqual(['quiet/solo', 'popular/spread']);
    expect(summary.singleAuthor).toBe(1);
  });

  it('sorts an unread project last rather than first', () => {
    // Null is not a low bus factor, and this table's whole point is which
    // projects rest on one person.
    const summary = summariseTrending([
      row({ id: 'unread/one', busFactor: null, topShare: null }),
      row({ id: 'known/two', busFactor: 2 }),
    ]);

    expect(summary.rising[0]?.id).toBe('known/two');
    expect(summary.measured).toBe(1);
  });

  it('reports only the newest read', () => {
    const summary = summariseTrending([
      row({ id: 'old/one', readAt: '2026-07-01' }),
      row({ id: 'new/one', readAt: '2026-08-07' }),
    ]);

    expect(summary.readAt).toBe('2026-08-07');
    expect(summary.projects).toBe(1);
  });

  it('reads an empty ledger as empty', () => {
    expect(summariseTrending([])).toMatchObject({ readAt: null, projects: 0, rising: [] });
  });
});
