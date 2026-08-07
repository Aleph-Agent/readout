import { describe, expect, it } from 'vitest';

import {
  collectContributors,
  concentration,
  MIN_COMMITS,
  PAGE_SIZE,
} from '../src/collectors/contributors.ts';
import { summariseContributors } from '../src/lib/contributors-summary.ts';
import type { GitHubClient } from '../src/lib/github.ts';
import type { ContributorRow } from '../src/types/contributors.ts';

/**
 * How concentrated a project's commit history is.
 *
 * The number is easy and the restraint is the work. A bus factor of one is a
 * statement about a distribution, and every route by which it could become a
 * statement about a project being unread — a 404, a 304, an exhausted budget —
 * has to keep the last reading instead.
 */

const NOW = '2026-08-07T02:17:00.000Z';

function client(
  answers: Record<string, { status: string; data?: { contributions: number }[] }>,
  options: { exhausted?: boolean; throws?: string[] } = {},
): GitHubClient {
  return {
    async getJson(path: string) {
      const repo = /\/repos\/([^?]+)\/contributors/.exec(path)?.[1] ?? '';
      if (options.throws?.includes(repo)) throw new Error('502');
      return (answers[repo] ?? { status: 'missing' }) as never;
    },
    stats: () => ({ consumed: 0, unchanged: 0, remaining: null }) as never,
    isExhausted: () => options.exhausted === true,
  };
}

function row(over: Partial<ContributorRow> = {}): ContributorRow {
  return {
    id: 'a/one',
    busFactor: 2,
    topShare: 0.4,
    contributors: 30,
    commits: 500,
    truncated: false,
    observedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('concentration', () => {
  it('counts contributors from the top until half the commits are covered', () => {
    // 60 of 100 is half on its own.
    expect(concentration([60, 20, 10, 10])).toMatchObject({ busFactor: 1, topShare: 0.6 });
    // 30 + 30 clears 50 of 100; one does not.
    expect(concentration([30, 30, 20, 20])).toMatchObject({ busFactor: 2, topShare: 0.3 });
  });

  it('spreads evenly when the history is spread evenly', () => {
    const even = Array.from({ length: 10 }, () => 10);
    expect(concentration(even)?.busFactor).toBe(5);
  });

  it('refuses a reading below the sample floor', () => {
    // A share of nine commits is a property of the sample, not the project.
    expect(concentration([MIN_COMMITS - 10, 5])).toBe(null);
  });

  it('ignores contributors with nothing recorded', () => {
    // Zeroes are dropped before the sum, so they cannot dilute a share.
    expect(concentration([100, 0, 0])).toMatchObject({ busFactor: 1, topShare: 1, commits: 100 });
  });
});

describe('collectContributors', () => {
  const ok = (counts: number[]) => ({
    status: 'ok',
    data: counts.map((contributions) => ({ contributions })),
  });

  it('records the shape of a repository it could read', async () => {
    const result = await collectContributors([], {
      now: NOW,
      repos: ['a/one'],
      client: client({ 'a/one': ok([600, 200, 200]) }),
    });

    expect(result.rows[0]).toMatchObject({
      id: 'a/one',
      busFactor: 1,
      topShare: 0.6,
      contributors: 3,
      commits: 1000,
      truncated: false,
    });
  });

  it('marks the contributor count as a floor when the page filled', async () => {
    // The bus factor is decided at the top of the distribution and is unaffected
    // by the unread tail. The count printed beside it would be a lie.
    const counts = [500, ...Array.from({ length: PAGE_SIZE - 1 }, () => 5)];
    const result = await collectContributors([], {
      now: NOW,
      repos: ['a/one'],
      client: client({ 'a/one': ok(counts) }),
    });

    expect(result.rows[0]?.truncated).toBe(true);
  });

  it.each([
    ['a repository that has gone', { 'a/one': { status: 'missing' } }, {}],
    ['a conditional request answered 304', { 'a/one': { status: 'unchanged' } }, {}],
    ['a request that threw', {}, { throws: ['a/one'] }],
    ['a budget that ran out', {}, { exhausted: true }],
  ])('keeps the last reading through %s', async (_label, answers, options) => {
    const held = [row()];
    const result = await collectContributors(held, {
      now: NOW,
      repos: ['a/one'],
      client: client(answers as never, options as never),
    });

    expect(result.rows).toEqual(held);
  });

  it('drops nothing and adds nothing for a repository it never held', async () => {
    const result = await collectContributors([], {
      now: NOW,
      repos: ['a/one'],
      client: client({}),
    });

    expect(result.rows).toEqual([]);
  });
});

describe('summariseContributors', () => {
  it('counts the projects resting half their history on one person', () => {
    const summary = summariseContributors([
      row({ id: 'a/one', busFactor: 1, topShare: 0.71 }),
      row({ id: 'b/two', busFactor: 1, topShare: 0.55 }),
      row({ id: 'c/three', busFactor: 9 }),
    ]);

    expect(summary).toMatchObject({ measured: 3, singleAuthor: 2, medianBusFactor: 1 });
    // Most concentrated first, and ties broken by the largest single share.
    expect(summary.concentrated.map((reading) => reading.repo)).toEqual([
      'a/one',
      'b/two',
      'c/three',
    ]);
  });

  it('reads an empty ledger as empty', () => {
    expect(summariseContributors([])).toMatchObject({ measured: 0, medianBusFactor: null });
  });
});
