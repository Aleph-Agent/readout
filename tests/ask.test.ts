import { describe, expect, it } from 'vitest';

import { buildAskContext, MAX_CONTEXT_BYTES } from '../src/site/ask-context.ts';
import { extractNumbers } from '../src/lib/validate.ts';
import type { EventRecord } from '../src/types/events.ts';
import type { IndexBundle, StripMark } from '../src/types/bundles.ts';

/**
 * The answer box is the one place a model speaks to a visitor directly, with no
 * build step in between to check it. Two things carry that: the record it is
 * given, and the rule that every number in the answer has to appear in that
 * record. This file tests both.
 */

function index(over: Partial<IndexBundle> = {}): IndexBundle {
  return {
    strip: [],
    scorecard: { resolved: 8, followed: 5, rate: 0.625, windowDays: 7, pending: 2 },
    today: [],
    watchlist: { total: 400, active: 388, byCategory: { devtool: 388 } },
    lenses: {
      ships: { status: 'active', count: 21 },
      forks: { status: 'active', count: 0 },
      demand: { status: 'active', count: 0 },
      stack: { status: 'pending', count: 0 },
      lineage: { status: 'active', count: 0 },
    },
    disclosure: { watchlistCurated: true, cadenceHours: 4, minBaselineDays: 14 },
    ...over,
  };
}

function event(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'fork-spike:a/one:2026-08-04',
    kind: 'fork-spike',
    repo: 'a/one',
    detectedAt: '2026-08-04T04:17:00.000Z',
    confidence: 'confirmed',
    summaryState: 'summarised',
    summary: "Forks rose by 60 over 24 hours, 24× this repository's 19-day baseline.",
    summarySource: 'model',
    evidenceUrl: 'https://github.com/a/one',
    metrics: { forksAdded: 60, observationHours: 24, multiplier: 24 },
    supersedes: null,
    ...over,
  } as EventRecord;
}

function mark(over: Partial<StripMark> = {}): StripMark {
  return {
    id: 'a/one',
    delta: 60,
    multiplier: 24,
    capped: false,
    state: 'confirmed',
    forks: 900,
    stars: 5000,
    language: 'Go',
    name: 'a/one',
    ...over,
  };
}

const NOW = '2026-08-06T04:17:00.000Z';

describe('what the model is allowed to see', () => {
  it('carries the findings, the repositories and the instrument itself', () => {
    const context = buildAskContext(index(), [event()], [mark()], NOW);

    expect(context.instrument.watching).toBe(388);
    expect(context.instrument.cadenceHours).toBe(4);
    expect(context.findings[0]?.repo).toBe('a/one');
    expect(context.repositories[0]?.repo).toBe('a/one');
    expect(context.record.followRate).toBe('63%');
  });

  it('states what each signal answers, so the model does not have to guess', () => {
    const context = buildAskContext(index(), [], [], NOW);
    expect(context.instrument.signals['ships']?.answers).toContain('released a new version');
    expect(context.instrument.signals['stack']?.status).toBe('pending');
  });

  it('carries the limits, so a question it cannot answer gets a reason', () => {
    // Without these the model reaches for what it knows instead of declining.
    // With them it can decline accurately, which is the difference between a
    // useful refusal and a vague one.
    const limits = buildAskContext(index(), [], [], NOW).instrument.limits.join(' ');

    expect(limits).toContain('curated by hand and partial');
    expect(limits).toContain('never against other repositories');
    expect(limits).toContain('never evidence of cause');
    expect(limits).toContain('Nothing here is real-time');
  });

  it('says too few rather than inventing a rate', () => {
    const context = buildAskContext(
      index({ scorecard: { resolved: 1, followed: 0, rate: null, windowDays: 7, pending: 0 } }),
      [],
      [],
      NOW,
    );
    expect(context.record.followRate).toBe('too few resolved findings to state a rate');
  });

  it('puts the newest findings first, because that is what gets asked about', () => {
    const older = event({ id: 'a', detectedAt: '2026-08-01T00:00:00.000Z', repo: 'old/one' });
    const newer = event({ id: 'b', detectedAt: '2026-08-05T00:00:00.000Z', repo: 'new/one' });
    const context = buildAskContext(index(), [older, newer], [], NOW);

    expect(context.findings.map((finding) => finding.repo)).toEqual(['new/one', 'old/one']);
  });

  it('stays under the size the endpoint can actually send', () => {
    // Not editorial, arithmetic. Groq's free tier counts one request against a
    // 6,000-token minute and refuses anything over it outright — 413, every
    // time. The first version shipped at 18KB and never answered once.
    const many = Array.from({ length: 400 }, (_, i) =>
      event({ id: `e${i}`, detectedAt: `2026-08-04T04:${String(i % 60).padStart(2, '0')}:00.000Z` }),
    );
    const marks = Array.from({ length: 400 }, (_, i) => mark({ id: `r${i}`, name: `owner${i}/repo` }));
    const serialised = JSON.stringify(buildAskContext(index(), many, marks, NOW));

    expect(Buffer.byteLength(serialised, 'utf8')).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
  });

  it('does not carry the metrics twice when a reading already states them', () => {
    // The published sentence is assembled from the metrics and states all of
    // them. Carrying both doubles the cost of a finding to say it twice.
    const summarised = buildAskContext(index(), [event()], [], NOW).findings[0];
    expect(summarised?.metrics).toBeUndefined();
    expect(summarised?.reading).toContain('60');

    // With no sentence, the metrics are the only record of the numbers, and
    // the answer may only quote a figure that appears in this file.
    const bare = buildAskContext(index(), [event({ summary: null })], [], NOW).findings[0];
    expect(bare?.metrics?.['forksAdded']).toBe(60);
  });
});

describe('the anchoring rule, as the endpoint applies it', () => {
  // A copy of the endpoint's check. The endpoint runs on workerd and cannot be
  // imported here, but the rule is the product decision and it is worth a test
  // that fails if the rule is ever weakened.
  function anchored(answer: string, contextText: string): boolean {
    const allowed = new Set(extractNumbers(contextText).map((token) => token.replace(/,/g, '')));
    for (const token of extractNumbers(answer)) {
      const bare = token.replace(/,/g, '');
      if (bare.length === 1) continue;
      if (!allowed.has(bare)) return false;
    }
    return true;
  }

  const record = JSON.stringify(buildAskContext(index(), [event()], [mark()], NOW));

  it('accepts an answer built from figures in the record', () => {
    expect(anchored('a/one added 60 forks over 24 hours.', record)).toBe(true);
  });

  it('rejects a figure that is nowhere in the record', () => {
    expect(anchored('a/one added 4127 forks last week.', record)).toBe(false);
  });

  it('rejects a total the model worked out for itself', () => {
    // The most likely failure and the least visible one: arithmetic that looks
    // right, is not in the record, and cannot be checked against anything.
    expect(anchored('The watchlist has grown by 388 to 776 repositories.', record)).toBe(false);
  });

  it('lets ordinary counting words through', () => {
    // "one repository", "the first 3" — prose, not a claimed measurement.
    expect(anchored('Only 1 repository has a confirmed reading.', record)).toBe(true);
  });

  it('reads a comma-grouped figure as the same number', () => {
    expect(anchored('It has 5,000 stars.', record)).toBe(true);
  });
});
