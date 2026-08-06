import { describe, expect, it } from 'vitest';

import { buildCoverage } from '../src/lib/coverage.ts';
import type { StripMark } from '../src/types/bundles.ts';
import type { EventRecord } from '../src/types/events.ts';
import type { WatchlistEntry } from '../src/types/watchlist.ts';

/**
 * Coverage answers "388 of what". Every figure in it is a claim about how the
 * watchlist is composed, and the composition is chosen by hand — so the rows
 * have to be exactly as honest as the rest of the record, and no more.
 */

function entry(id: string, category: string, active = true): WatchlistEntry {
  return { id, category, added: '2026-07-01', active } as WatchlistEntry;
}

function mark(id: string, category: string, delta: number | null): StripMark {
  return {
    id,
    delta,
    multiplier: delta === null ? null : 2,
    capped: false,
    state: delta === null ? 'forming' : 'quiet',
    forks: 100,
    stars: 1000,
    language: 'Go',
    name: id,
    category,
  };
}

function event(repo: string): EventRecord {
  return {
    id: `release:${repo}:v1`,
    kind: 'release',
    repo,
    detectedAt: '2026-08-04T04:17:00.000Z',
    confidence: 'confirmed',
    // Releases never queue for prose: the template says everything the record
    // holds and a model adds only the chance of being wrong.
    summaryState: 'skipped',
    summary: null,
    summarySource: null,
    evidenceUrl: `https://github.com/${repo}`,
    metrics: { tag: 'v1' },
    supersedes: null,
  };
}

describe('what the watchlist is pointed at', () => {
  it('counts repositories, measurements and findings per category', () => {
    const rows = buildCoverage(
      [entry('a/one', 'ai-ml'), entry('b/two', 'ai-ml'), entry('c/three', 'database')],
      [mark('a/one', 'ai-ml', 30), mark('b/two', 'ai-ml', 12), mark('c/three', 'database', 5)],
      [event('a/one'), event('a/one'), event('c/three')],
    );

    expect(rows).toEqual([
      { category: 'ai-ml', repositories: 2, measured: 2, forksAdded: 42, findings: 2, busiest: 'a/one' },
      { category: 'database', repositories: 1, measured: 1, forksAdded: 5, findings: 1, busiest: 'c/three' },
    ]);
  });

  it('sorts alphabetically rather than by size', () => {
    // Sorting by size ranks the categories, and a ranking is a claim — that one
    // area matters more than another — which nothing here measures.
    const rows = buildCoverage(
      [entry('a/one', 'web-framework'), entry('b/two', 'ai-ml'), entry('c/three', 'ai-ml')],
      [],
      [],
    );
    expect(rows.map((row) => row.category)).toEqual(['ai-ml', 'web-framework']);
  });

  it('shows no figure rather than a zero when nothing is measurable yet', () => {
    // "Not measured yet" and "measured at zero" are different claims and must
    // not render the same. This is the cold-start state for every category.
    const rows = buildCoverage([entry('a/one', 'ai-ml')], [mark('a/one', 'ai-ml', null)], []);

    expect(rows[0]?.measured).toBe(0);
    expect(rows[0]?.forksAdded).toBeNull();
    expect(rows[0]?.busiest).toBeNull();
  });

  it('counts what is being read now, not what has ever been read', () => {
    const rows = buildCoverage(
      [entry('a/one', 'ai-ml'), entry('b/two', 'ai-ml', false)],
      [],
      [],
    );
    expect(rows[0]?.repositories).toBe(1);
  });

  it('keeps a retired repository’s findings in its category', () => {
    // The reading happened and the site has already published it. Dropping it
    // would quietly shrink a total that is on record.
    const rows = buildCoverage(
      [entry('a/one', 'ai-ml'), entry('gone/repo', 'ai-ml', false)],
      [],
      [event('gone/repo')],
    );
    expect(rows[0]?.findings).toBe(1);
  });

  it('names the largest single contributor, not the busiest by forks', () => {
    // The column sits beside Forks added and has to be the repository that
    // produced it, or the row does not add up on inspection.
    const rows = buildCoverage(
      [entry('small/one', 'ai-ml'), entry('big/two', 'ai-ml')],
      [mark('small/one', 'ai-ml', 90), mark('big/two', 'ai-ml', 3)],
      [],
    );
    expect(rows[0]?.busiest).toBe('small/one');
  });

  it('has nothing to say about a watchlist that is empty', () => {
    expect(buildCoverage([], [], [])).toEqual([]);
  });
});
