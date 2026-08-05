import { describe, expect, it } from 'vitest';

import { renderRepoPage, type RepoPageData, type RepoSeriesPoint } from '../src/site/repo.ts';
import type { IndexBundle } from '../src/types/bundles.ts';
import type { EventRecord } from '../src/types/events.ts';
import { EMPTY_META, type MetaRecord } from '../src/types/meta.ts';
import type { LiveStateRow } from '../src/types/state.ts';
import type { WatchlistEntry } from '../src/types/watchlist.ts';

const meta: MetaRecord = { ...EMPTY_META, lastSuccessfulRunAt: '2026-08-04T04:17:00Z' };

const index: IndexBundle = {
  strip: [],
  scorecard: { resolved: 0, followed: 0, rate: null, windowDays: 7, pending: 0 },
  today: [],
  watchlist: { total: 400, active: 400, byCategory: {} },
  lenses: {
    ships: { status: 'active', count: 0 },
    forks: { status: 'active', count: 0 },
    demand: { status: 'pending', count: 0 },
    stack: { status: 'pending', count: 0 },
    lineage: { status: 'pending', count: 0 },
  },
  disclosure: { watchlistCurated: true, cadenceHours: 4, minBaselineDays: 14 },
};

function entry(id: string): WatchlistEntry {
  return { id, category: 'ai-ml', added: '2026-07-01', active: true };
}

function state(id: string, over: Partial<LiveStateRow> = {}): LiveStateRow {
  return {
    id,
    active: true,
    forks: 1200,
    stars: 24000,
    openIssues: 310,
    language: 'Python',
    pushedAt: '2026-08-04T02:00:00Z',
    latestReleaseTag: 'v2.9.0',
    latestReleaseAt: '2026-08-03T18:00:00Z',
    etag: null,
    releaseEtag: null,
    ...over,
  };
}

function series(days: number, perDay: number): RepoSeriesPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.parse('2026-08-04T00:00:00Z') - (days - i) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    forks: 1000 + i * perDay,
    added: i === 0 ? 0 : perDay,
  }));
}

function page(over: Partial<RepoPageData>): string {
  const data: RepoPageData = {
    entry: entry('a/one'),
    state: state('a/one'),
    series: [],
    baselinePerDay: null,
    baselineDays: 0,
    events: [],
    totalEvents: 0,
    ...over,
  };
  return renderRepoPage(data, index, meta);
}

function event(over: Partial<EventRecord>): EventRecord {
  return {
    id: 'x',
    kind: 'release',
    repo: 'a/one',
    detectedAt: '2026-08-03T18:00:00Z',
    confidence: 'confirmed',
    summaryState: 'skipped',
    summary: null,
    evidenceUrl: 'https://github.com/a/one/releases/tag/v2.9.0',
    metrics: {},
    supersedes: null,
    ...over,
  };
}

/* ------------------------------------------------------------------------ */
/* History 1: busy — a release, a spike hours later, prose attached.         */
/* ------------------------------------------------------------------------ */

describe('a repository with a dense history', () => {
  const events = [
    event({
      id: 'fork-spike:a/one:2026-08-04',
      kind: 'fork-spike',
      detectedAt: '2026-08-04T02:17:00Z',
      summaryState: 'summarised',
      summary: "Forks rose by 240 over 24 hours, 12× this repository's 30-day baseline.",
      evidenceUrl: 'https://github.com/a/one',
      metrics: { forksAdded: 240, observationHours: 24, multiplier: 12 },
    }),
    event({ id: 'release:a/one:v2.9.0', metrics: { tag: 'v2.9.0' } }),
  ];

  const html = page({
    series: series(30, 8),
    baselinePerDay: 8,
    baselineDays: 29,
    events,
    totalEvents: 2,
  });

  it('puts the timeline first, as structure rather than a tab', () => {
    expect(html).toContain('class="timeline"');
    expect(html).not.toContain('role="tablist"');
  });

  it('states the elapsed time between adjacent signals', () => {
    // A release, then a spike eight hours later, is a story only if the gap is
    // legible. Making the reader subtract two timestamps loses it.
    expect(html).toContain('8h earlier');
  });

  it('draws the baseline wherever a comparison is made', () => {
    expect(html).toContain('baseline-rule');
    expect(html).toContain('8.0/day trailing mean');
  });

  it('shows confidence per event and links each claim to its evidence', () => {
    expect(html).toContain('state-confirmed');
    expect(html).toContain('href="https://github.com/a/one/releases/tag/v2.9.0"');
  });

  it('keeps generated prose in its own face, beside the numbers it explains', () => {
    expect(html).toContain('<p class="prose">');
    expect(html).toContain('12× this');
  });

  it('plots additions per day rather than a cumulative total', () => {
    // A running total only ever rises and hides the thing being measured.
    expect(html).toContain('Forks added per day');
    expect(html).toContain('30 daily samples');
  });
});

/* ------------------------------------------------------------------------ */
/* History 2: measured, but nothing has ever crossed the bar.                */
/* ------------------------------------------------------------------------ */

describe('a repository with readings but no signals', () => {
  const html = page({ series: series(30, 2), baselinePerDay: 2, baselineDays: 29 });

  it('says nothing crossed the bar, and when watching started', () => {
    expect(html).toContain('No signals recorded');
    expect(html).toContain('2026-07-01');
  });

  it('still shows the readings and the chart', () => {
    expect(html).toContain('Forks added per day');
    expect(html).toContain('1200');
  });

  it('reports the baseline it does have', () => {
    expect(html).toContain('2.0/day');
    expect(html).toContain('29 days of history');
  });
});

/* ------------------------------------------------------------------------ */
/* History 3: almost nothing — on the watchlist, never collected.            */
/* ------------------------------------------------------------------------ */

describe('a repository with almost no history', () => {
  const html = page({ entry: entry('c/three'), state: null });

  it('renders a valid page rather than a broken one', () => {
    expect(html).toContain('c/three');
    expect(html).toContain('</html>');
  });

  it('says what is missing instead of showing zeros', () => {
    // Zeros would be a measurement. Nothing has been measured.
    expect(html).toContain('has not been collected');
    expect(html).toContain('Baseline forming');
    expect(html).toContain('no rate can be computed yet');
  });

  it('never fabricates a multiplier', () => {
    expect(html).not.toContain('trailing mean');
  });
});

/* ------------------------------------------------------------------------ */

describe('edge cases', () => {
  it('says plainly when a repository stopped being reachable', () => {
    const html = page({ state: state('a/one', { active: false }) });
    expect(html).toContain('No longer reachable');
    expect(html).toContain('deleted, renamed, or made private');
  });

  it('discloses truncation rather than silently dropping history', () => {
    const html = page({ events: [event({})], totalEvents: 240 });
    expect(html).toContain('Older signals not shown');
    expect(html).toContain('239 earlier signals');
    expect(html).toContain('Timeline — 240 recorded signals');
  });

  it('escapes a repository name, which is chosen by someone else', () => {
    const html = page({ entry: entry('evil/<script>alert(1)</script>') });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
