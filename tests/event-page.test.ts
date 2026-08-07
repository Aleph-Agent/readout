import { describe, expect, it } from 'vitest';

import { eventDescription, renderEventPage } from '../src/site/event.ts';
import { renderIndex } from '../src/site/render.ts';
import { isRepositorySubject, type EventRecord } from '../src/types/events.ts';
import type { IndexBundle } from '../src/types/bundles.ts';
import { EMPTY_META, type MetaRecord } from '../src/types/meta.ts';

/**
 * `repo` carries the subject of every finding, and for three kinds the subject
 * is not a repository. A model id and a `product/cycle` pair both fit
 * `owner/name`, so nothing about their shape says they are not on GitHub — and
 * every place that assumed they were printed something false.
 */

const meta: MetaRecord = { ...EMPTY_META, lastSuccessfulRunAt: '2026-08-07T02:17:00Z' };

const index: IndexBundle = {
  strip: [],
  scorecard: { resolved: 0, followed: 0, rate: null, windowDays: 7, pending: 0 },
  today: [],
  watchlist: { total: 400, active: 388, byCategory: {} },
  coverage: [],
  calibration: [],
  adoption: { measured: 0, unread: 0, weekly: 0, weeklyPackages: 0, top: [] },
  models: { available: 0, providers: 0, withdrawn: 0, cheapest: [], dearest: [], moved: [], perContext: [] },
  lifecycle: { products: 0, dated: 0, ended: 0, approaching: 0, soon: [], supported: [] },
  incidents: { windowDays: 90, providers: 0, total: 0, observedDays: 0, byProvider: [], recent: [] },
  staleness: { measured: 0, unread: 0, medianDays: null, overAYear: 0, quietest: [], byRegistry: [] },
  advisories: { registries: 0, total: 0, byRegistry: [] },
  questions: { windowDays: 0, tags: 0, total: 0, medianChange: null, busiest: [], holding: [], fading: [] },
  hiring: { month: null, sample: 0, previousMonth: null, previousSample: 0, top: [], rising: [], falling: [] },
  divergence: { compared: 0, median: null, used: [], watched: [] },
  health: { scored: 0, unscored: 0, median: null, advisories: 0, weakest: [] },
  lenses: {
    ships: { status: 'active', count: 0 },
    forks: { status: 'active', count: 0 },
    demand: { status: 'active', count: 0 },
    stack: { status: 'active', count: 0 },
    lineage: { status: 'active', count: 0 },
  },
  disclosure: { watchlistCurated: true, cadenceHours: 4, minBaselineDays: 14 },
};

const eol: EventRecord = {
  id: 'eol-approaching:python/3.10:2026-08-07',
  kind: 'eol-approaching',
  repo: 'python/3.10',
  detectedAt: '2026-08-07T02:17:00Z',
  confidence: 'confirmed',
  summaryState: 'skipped',
  summary: null,
  summarySource: null,
  evidenceUrl: 'https://endoflife.date/python',
  metrics: { product: 'python', cycle: '3.10', eol: '2026-10-31', daysRemaining: 85 },
  supersedes: null,
};

const spike: EventRecord = {
  id: 'fork-spike:a/one:2026-08-07',
  kind: 'fork-spike',
  repo: 'a/one',
  detectedAt: '2026-08-07T02:17:00Z',
  confidence: 'confirmed',
  summaryState: 'skipped',
  summary: null,
  summarySource: null,
  evidenceUrl: 'https://github.com/a/one',
  metrics: { forksAdded: 60, observationHours: 24, multiplier: 24 },
  supersedes: null,
};

describe('isRepositorySubject', () => {
  it('separates the three kinds whose subject is not a repository', () => {
    expect(isRepositorySubject('fork-spike')).toBe(true);
    expect(isRepositorySubject('release')).toBe(true);
    expect(isRepositorySubject('eol-approaching')).toBe(false);
    expect(isRepositorySubject('model-price')).toBe(false);
    expect(isRepositorySubject('model-withdrawn')).toBe(false);
  });
});

describe('event pages', () => {
  it('names the evidence link by where it actually goes', () => {
    expect(renderEventPage(eol, index, meta)).toContain('Verify at endoflife.date');
    expect(renderEventPage(spike, index, meta)).toContain('Verify on GitHub');
  });

  it('offers a repository page only when there is a repository', () => {
    expect(renderEventPage(eol, index, meta)).not.toContain('/repo/python/3.10');
    expect(renderEventPage(spike, index, meta)).toContain('/repo/a/one');
  });

  it('points at the bundle the figures came from, not at a lens they are not in', () => {
    expect(renderEventPage(eol, index, meta)).toContain('/data/eol.json');
    expect(renderEventPage(spike, index, meta)).toContain('/data/forks.json');
  });

  it('states an end-of-life date as its publisher published it', () => {
    // Restated, attributed, and not a prediction made here.
    expect(eventDescription(eol)).toBe(
      'python 3.10 stops receiving fixes on 2026-10-31, in 85 days, according to endoflife.date.',
    );
  });
});

describe("today's table", () => {
  it('sends a non-repository subject to its finding, not to a profile page', () => {
    const html = renderIndex({ ...index, today: [eol, spike] }, meta);

    expect(html).toContain('/e/eol-approaching-python-3-10-2026-08-07');
    expect(html).not.toContain('/repo/python/3.10');
    expect(html).toContain('/repo/a/one');
  });
});
