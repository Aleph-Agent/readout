import { describe, expect, it } from 'vitest';

import { renderIndex, renderLens, stripSvg } from '../src/site/render.ts';
import type { IndexBundle, LensBundle, StripMark } from '../src/types/bundles.ts';
import type { EventRecord } from '../src/types/events.ts';
import { EMPTY_META, type MetaRecord } from '../src/types/meta.ts';

function meta(over: Partial<MetaRecord> = {}): MetaRecord {
  return { ...EMPTY_META, lastSuccessfulRunAt: '2026-08-04T04:17:00Z', job: 'pulse', ...over };
}

function mark(over: Partial<StripMark> = {}): StripMark {
  return { id: 'a/one', delta: 0, multiplier: 1, capped: false, state: 'quiet', forks: 100, ...over };
}

function index(over: Partial<IndexBundle> = {}): IndexBundle {
  return {
    strip: [],
    scorecard: { resolved: 0, followed: 0, rate: null, windowDays: 7, pending: 0 },
    today: [],
    watchlist: { total: 400, active: 400, byCategory: { devtool: 400 } },
    lenses: {
      ships: { status: 'active', count: 0 },
      forks: { status: 'active', count: 0 },
      demand: { status: 'pending', count: 0 },
      stack: { status: 'pending', count: 0 },
      lineage: { status: 'pending', count: 0 },
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
    detectedAt: '2026-08-04T04:17:00Z',
    confidence: 'confirmed',
    summaryState: 'summarised',
    summary: "Forks rose by 60 over 24 hours, 24× this repository's 19-day baseline.",
    evidenceUrl: 'https://github.com/a/one',
    metrics: { forksAdded: 60, observationHours: 24, multiplier: 24 },
    supersedes: null,
    ...over,
  };
}

function lens(over: Partial<LensBundle> = {}): LensBundle {
  return {
    lens: 'forks',
    status: 'active',
    records: [],
    windowDays: 90,
    archives: [],
    count: 0,
    withdrawn: 0,
    ...over,
  };
}

const COPY = { title: 'Forks', heading: 'Fork activity', noun: 'fork spike' };

describe('required states', () => {
  it('says the watchlist was checked and nothing crossed the threshold', () => {
    // A quiet instrument reporting nothing detected is working correctly.
    const html = renderIndex(index(), meta());
    expect(html).toContain('Nothing crossed the threshold');
    expect(html).toContain('400 repositories were checked');
  });

  it('distinguishes a lens with no collector from a lens that found nothing', () => {
    const quiet = renderLens(lens(), index(), meta(), COPY);
    const notMeasured = renderLens(lens({ status: 'pending' }), index(), meta(), COPY);

    expect(quiet).toContain('Nothing crossed the threshold');
    expect(notMeasured).toContain('Not measured yet');
    expect(notMeasured).toContain('not because nothing happened');
  });

  it('reports how many baselines are still forming, without inventing multipliers', () => {
    const html = renderIndex(
      index({ strip: [mark({ state: 'forming', multiplier: null }), mark({ id: 'b/two' })] }),
      meta(),
    );
    expect(html).toContain('Baseline forming');
    expect(html).toContain('1 of 2 repositories');
    expect(html).toContain('none is implied');
  });

  it('surfaces a partial run rather than hiding it', () => {
    const html = renderIndex(index(), meta({ partial: true, collectorsErrored: ['releases: 502'] }));
    expect(html).toContain('most recent run was partial');
  });

  it('renders the exact reading time server-side, so it survives without scripting', () => {
    const html = renderIndex(index(), meta());
    expect(html).toContain('2026-08-04 04:17 UTC');
    expect(html).toContain('data-stale-after="480"');
  });

  it('says there is no reading yet before the first run', () => {
    const html = renderIndex(index(), meta({ lastSuccessfulRunAt: null }));
    expect(html).toContain('No reading yet');
  });
});

describe('the velocity strip', () => {
  it('draws the baseline explicitly, so the comparison is visible', () => {
    // A comparison whose reference the reader cannot see is not checkable.
    const svg = stripSvg([mark(), mark({ id: 'b/two' })], new Set());
    expect(svg).toContain('baseline-rule');
    expect(svg).toContain("this repository's normal");
  });

  it('gives a confirmed spike the alert treatment and a quiet repository none', () => {
    const svg = stripSvg([mark({ state: 'confirmed', multiplier: 30 }), mark({ id: 'b/two' })], new Set());
    expect(svg).toContain('mark-confirmed');
    expect(svg).toContain('mark-quiet');
  });

  it('draws a forming baseline as an outline rather than a zero-height bar', () => {
    // "Not measured yet" must not render as "measured at zero".
    const svg = stripSvg(
      [mark({ state: 'forming', multiplier: null }), mark({ id: 'b/two', state: 'quiet' })],
      new Set(),
    );
    expect(svg).toContain('mark-forming');
  });

  it('says so in a sentence rather than drawing 400 identical marks', () => {
    // Before any window fills, every mark is the same height and colour: fifty
    // kilobytes of SVG conveying nothing.
    const nothing = Array.from({ length: 400 }, (_, i) =>
      mark({ id: `r${i}/x`, state: 'forming', multiplier: null }),
    );
    const html = stripSvg(nothing, new Set());

    expect(html).not.toContain('<rect');
    expect(html).toContain('Baseline forming');
    expect(html).toContain('400 repositories');
    expect(html.length).toBeLessThan(1000);
  });

  it('carries a text alternative, since the table below is the accessible path', () => {
    const svg = stripSvg([mark({ state: 'confirmed', multiplier: 30 })], new Set());
    expect(svg).toContain('role="img"');
    expect(svg).toContain('1 confirmed above baseline');
  });

  it('renders nothing at all rather than an empty frame', () => {
    expect(stripSvg([], new Set())).toBe('');
  });
});

describe('retractions', () => {
  it('discloses withdrawn findings by count rather than hiding them', () => {
    const html = renderLens(lens({ withdrawn: 140 }), index(), meta(), COPY);
    expect(html).toContain('Withdrawn');
    expect(html).toContain('140 earlier findings have been');
    expect(html).toContain('remain in the');
  });

  it('says nothing when nothing was withdrawn', () => {
    expect(renderLens(lens(), index(), meta(), COPY)).not.toContain('Withdrawn');
  });
});

describe('honesty of presentation', () => {
  it('sets generated prose in its own face, apart from the measurements', () => {
    const html = renderLens(lens({ records: [event()], count: 1 }), index(), meta(), COPY);
    expect(html).toContain('<p class="prose">');
    expect(html).toContain("24× this repository's 19-day baseline.");
  });

  it('never encodes a state in colour alone', () => {
    const html = renderLens(lens({ records: [event()], count: 1 }), index(), meta(), COPY);
    // The class carries the colour; the text carries the meaning.
    expect(html).toContain('state-confirmed');
    expect(html).toContain('>confirmed<');
  });

  it('links every claim to its evidence', () => {
    const html = renderLens(lens({ records: [event()], count: 1 }), index(), meta(), COPY);
    expect(html).toContain('href="https://github.com/a/one"');
  });

  it('discloses that the watchlist is curated and the data is not real-time', () => {
    const html = renderIndex(index(), meta());
    expect(html).toContain('curated and partial');
    expect(html).toContain('not real-time');
  });

  it('escapes third-party text, which is where the injection would come from', () => {
    // Tag names and repository names are chosen by people we do not control.
    const hostile = event({
      repo: 'evil/<script>alert(1)</script>',
      summary: '<img src=x onerror=alert(1)>',
      evidenceUrl: 'https://github.com/"onmouseover="alert(1)',
    });
    const html = renderLens(lens({ records: [hostile], count: 1 }), index(), meta(), COPY);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('navigation', () => {
  it('marks lenses that are not collecting yet', () => {
    const html = renderIndex(index(), meta());
    expect(html).toContain('data-pending="true"');
    expect(html).toContain('aria-current="page"');
  });

  it('never links to a .html path', () => {
    // Pages serves ships.html at /ships and answers /ships.html with a 308.
    // Linking with the extension puts a redirect in front of every navigation.
    const pages = [
      renderIndex(index({ today: [event()], strip: [mark()] }), meta()),
      renderLens(lens({ records: [event()], count: 1 }), index(), meta(), COPY),
    ];

    for (const html of pages) {
      const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] as string);
      expect(links.filter((href) => href.endsWith('.html'))).toEqual([]);
    }
  });

  it('marks the current lens without the extension', () => {
    const html = renderLens(lens(), index(), meta(), COPY);
    expect(html).toContain('href="/forks" aria-current="page"');
  });
});
