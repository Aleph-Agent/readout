import { describe, expect, it } from 'vitest';

import { MIN_INSTALLS, MIN_STARS, summariseDivergence } from '../src/lib/divergence.ts';

/**
 * The one reading here no single source could produce — and the one most able
 * to lie, because a low install count usually means "distributed somewhere
 * else" rather than "nobody uses it".
 */

function repo(name: string, stars: number, installs: number | null) {
  return { id: name, name, stars, installs };
}

describe('the floor', () => {
  it('refuses a package below the install floor', () => {
    // faiss ships as faiss-cpu and kibana is not installed through npm at all.
    // Both showed under 100 weekly installs against tens of thousands of stars,
    // and reporting either as ignored would be a confident lie.
    const summary = summariseDivergence([repo('facebookresearch/faiss', 40_675, 91)]);
    expect(summary.compared).toBe(0);
  });

  it('refuses a repository with too few stars for a ratio to mean anything', () => {
    expect(summariseDivergence([repo('tiny/one', 12, 5_000_000)]).compared).toBe(0);
  });

  it('refuses a package with no install reading at all', () => {
    expect(summariseDivergence([repo('a/one', 10_000, null)]).compared).toBe(0);
  });

  it('accepts a repository that clears both', () => {
    const summary = summariseDivergence([repo('a/one', MIN_STARS, MIN_INSTALLS)]);
    expect(summary.compared).toBe(1);
  });
});

describe('the two ends', () => {
  const rows = [
    repo('nodejs/undici', 7_654, 158_049_961),
    repo('numpy/numpy', 32_511, 286_460_726),
    repo('pulumi/pulumi', 25_533, 13_879),
    repo('directus/directus', 37_177, 21_902),
  ];

  it('puts the most-used-per-star first', () => {
    // 7,654 stars against 158 million weekly installs. Nothing on GitHub says
    // that, and it is the whole argument for joining two sources.
    expect(summariseDivergence(rows).used[0]?.repo).toBe('nodejs/undici');
  });

  it('puts the least-used-per-star first on the other list', () => {
    // pulumi is 0.54 installs per star, directus 0.59.
    expect(summariseDivergence(rows).watched[0]?.repo).toBe('pulumi/pulumi');
  });

  it('reports the median, so either end has something to sit against', () => {
    expect(summariseDivergence(rows).median).not.toBeNull();
  });

  it('breaks ties by name, so the bundle is byte-identical run to run', () => {
    const tied = [repo('b/two', 1000, 100_000), repo('a/one', 1000, 100_000)];
    expect(summariseDivergence(tied).watched.map((r) => r.repo)).toEqual(['a/one', 'b/two']);
  });

  it('has nothing to say when nothing qualifies', () => {
    expect(summariseDivergence([])).toEqual({
      compared: 0,
      median: null,
      used: [],
      watched: [],
    });
  });
});
