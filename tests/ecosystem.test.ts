import { describe, expect, it } from 'vitest';

import { collectImages, type ImageClient } from '../src/collectors/images.ts';
import { collectQuestions, type QuestionClient } from '../src/collectors/questions.ts';
import { collectStaleness, daysSince, type StalenessClient } from '../src/collectors/staleness.ts';
import {
  candidates,
  collectTyposquats,
  MIN_LENGTH,
  type TyposquatClient,
} from '../src/collectors/typosquat.ts';
import { summariseAdvisories } from '../src/lib/advisory-summary.ts';
import { MIN_BASE, summariseQuestions } from '../src/lib/questions-summary.ts';
import { summariseStaleness } from '../src/lib/staleness-summary.ts';
import type { AdoptionRow } from '../src/types/adoption.ts';
import type { HealthRow } from '../src/types/health.ts';
import type { StalenessRow } from '../src/types/staleness.ts';
import type { TyposquatRow } from '../src/types/typosquat.ts';

/**
 * The four readings that never touch GitHub.
 *
 * They share one failure mode, and it is the one that matters: a registry that
 * refuses, a quota that runs out, and a package that genuinely went away all
 * arrive at the call site looking identical. Only the last is news. Every
 * collector here is tested for keeping what it already knew when it cannot tell
 * which of the three just happened.
 */

const NOW = '2026-08-07T02:17:00.000Z';
const TODAY = '2026-08-07';

function pkg(over: Partial<AdoptionRow> = {}): AdoptionRow {
  return {
    id: 'acme/thing',
    registry: 'npm',
    name: 'thing',
    count: 1000,
    window: 'week',
    observedAt: NOW,
    samples: [],
    ...over,
  } as AdoptionRow;
}

// ------------------------------------------------------------------ staleness

describe('when a package last shipped', () => {
  function client(dates: Record<string, { at: string; version: string }>, fail: string[] = []): StalenessClient {
    let spent = 0;
    return {
      requests: () => spent,
      async lastPublish(_registry, name) {
        spent += 1;
        if (fail.includes(name)) throw new Error('429 refused');
        return dates[name] ?? null;
      },
    };
  }

  const held: StalenessRow[] = [
    {
      registry: 'npm',
      name: 'thing',
      repo: 'acme/thing',
      lastPublish: '2020-01-01',
      version: '1.0.0',
      observedAt: '2026-08-01T00:00:00.000Z',
    },
  ];

  it('records the date the newest version was published', async () => {
    const result = await collectStaleness(
      [pkg()],
      [],
      { now: NOW, delayMs: 0, client: client({ thing: { at: '2024-03-05T10:00:00Z', version: '4.1.0' } }) },
    );

    expect(result.rows[0]).toMatchObject({ lastPublish: '2024-03-05', version: '4.1.0' });
  });

  it('carries the last known date forward when the registry refuses', async () => {
    // Throttling is not a package that stopped existing, and pypi refuses
    // dozens of reads on an ordinary day.
    const result = await collectStaleness([pkg()], held, {
      now: NOW,
      delayMs: 0,
      client: client({}, ['thing']),
    });

    expect(result.rows).toEqual(held);
    expect(result.errors[0]).toContain('thing');
  });

  it('reads one package once however many repositories map to it', async () => {
    const c = client({ thing: { at: '2024-03-05T10:00:00Z', version: '4.1.0' } });
    await collectStaleness(
      [pkg(), pkg({ id: 'other/thing' })],
      [],
      { now: NOW, delayMs: 0, client: c },
    );

    expect(c.requests()).toBe(1);
  });

  it('leaves Homebrew alone', async () => {
    // A formula records when somebody packaged software, not when it shipped.
    const c = client({});
    const result = await collectStaleness([pkg({ registry: 'brew' })], [], {
      now: NOW,
      delayMs: 0,
      client: c,
    });

    expect(c.requests()).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it('counts days from the publish date', () => {
    expect(daysSince('2026-07-08T00:00:00Z', TODAY)).toBe(30);
  });

  it('summarises the quiet ones first and states the sample', () => {
    const summary = summariseStaleness(
      [
        { ...held[0]!, name: 'ancient', lastPublish: '2018-01-01' },
        { ...held[0]!, name: 'fresh', lastPublish: '2026-08-01' },
      ],
      TODAY,
    );

    expect(summary.measured).toBe(2);
    expect(summary.quietest[0]?.name).toBe('ancient');
    expect(summary.overAYear).toBe(1);
  });
});

// ----------------------------------------------------------------- advisories

describe('advisory load per ecosystem', () => {
  function health(id: string, advisories: number | null): HealthRow {
    return { id, scorecard: null, scoredAt: null, advisories, observedAt: NOW } as HealthRow;
  }

  it('splits the load by registry and names the worst', () => {
    const summary = summariseAdvisories(
      [
        pkg({ id: 'a/one', name: 'one', registry: 'npm' }),
        pkg({ id: 'b/two', name: 'two', registry: 'npm' }),
        pkg({ id: 'c/three', name: 'three', registry: 'crates' }),
      ],
      [health('a/one', 10), health('b/two', 0), health('c/three', 3)],
    );

    expect(summary.total).toBe(13);
    expect(summary.byRegistry[0]).toMatchObject({
      registry: 'npm',
      packages: 2,
      affected: 1,
      advisories: 10,
      perAffected: 10,
    });
    expect(summary.byRegistry[0]?.worst[0]?.name).toBe('one');
  });

  it('treats an unread repository as absent, not as clean', () => {
    // Counting it zero would flatter whichever ecosystem happened to go unread.
    const summary = summariseAdvisories(
      [pkg({ id: 'a/one', name: 'one' }), pkg({ id: 'b/two', name: 'two' })],
      [health('a/one', 4), health('b/two', null)],
    );

    expect(summary.byRegistry[0]?.packages).toBe(1);
  });

  it('counts a package once when two repositories map to it', () => {
    const summary = summariseAdvisories(
      [pkg({ id: 'a/one', name: 'one' }), pkg({ id: 'a/one', name: 'one' })],
      [health('a/one', 5)],
    );

    expect(summary.total).toBe(5);
  });
});

// ------------------------------------------------------------------ typosquat

describe('names one keystroke away', () => {
  it('generates deletions and transpositions and nothing else', () => {
    const found = candidates('abcd');

    expect(found).toContain('bcd');
    expect(found).toContain('abc');
    expect(found).toContain('bacd');
    expect(found).toContain('abdc');
    expect(found).not.toContain('abcd');
    // Bounded by length. The full edit-distance-1 space is hundreds of names
    // per package, which is both too many requests and rude.
    expect(found.length).toBeLessThanOrEqual(8);
  });

  function client(exists: Record<string, string>, fail: string[] = []): TyposquatClient {
    let spent = 0;
    return {
      requests: () => spent,
      async published(name) {
        spent += 1;
        if (fail.includes(name)) throw new Error('503');
        return exists[name] ?? null;
      },
    };
  }

  it('records only names the registry actually has', async () => {
    const result = await collectTyposquats(
      [pkg({ name: 'bootstrap' })],
      [],
      { now: NOW, delayMs: 0, client: client({ boostrap: '2024-01-05T00:00:00Z' }) },
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      canonical: 'bootstrap',
      name: 'boostrap',
      distance: 1,
      lastPublish: '2024-01-05',
    });
  });

  it('stops listing a neighbour that has been taken down', async () => {
    // Naming a package that no longer exists beside the word typosquat is the
    // one outcome here with no upside whatsoever.
    const held: TyposquatRow[] = [
      {
        canonical: 'bootstrap',
        name: 'boostrap',
        distance: 1,
        lastPublish: '2024-01-05',
        observedAt: NOW,
      },
    ];

    const result = await collectTyposquats([pkg({ name: 'bootstrap' })], held, {
      now: NOW,
      delayMs: 0,
      client: client({}),
    });

    expect(result.rows).toEqual([]);
  });

  it('keeps its findings when a sweep could not complete', async () => {
    const held: TyposquatRow[] = [
      { canonical: 'abcd', name: 'abc', distance: 1, lastPublish: '2024-01-05', observedAt: NOW },
    ];

    const result = await collectTyposquats([pkg({ name: 'abcd' })], held, {
      now: NOW,
      delayMs: 0,
      client: client({}, ['bcd']),
    });

    expect(result.rows).toEqual(held);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('leaves short names alone', async () => {
    const c = client({});
    await collectTyposquats([pkg({ name: 'x'.repeat(MIN_LENGTH - 1) })], [], {
      now: NOW,
      delayMs: 0,
      client: c,
    });

    expect(c.requests()).toBe(0);
  });
});

// --------------------------------------------------------------------- images

describe('base image tags', () => {
  function client(tags: Record<string, { bytes: number; updatedAt: string }>): ImageClient {
    let spent = 0;
    return {
      requests: () => spent,
      async tag(image, name) {
        spent += 1;
        return tags[`${image}:${name}`] ?? null;
      },
    };
  }

  const tracked = [{ image: 'node', tags: ['24', '24-alpine'] }];

  it('asks for each tag by name', async () => {
    // Paged, `node:24-alpine` fell off a hundred-tag page ordered by rebuild
    // date and was reported as a tag that had stopped being published.
    const result = await collectImages([], {
      now: NOW,
      delayMs: 0,
      tracked,
      client: client({
        'node:24': { bytes: 409_000_000, updatedAt: '2026-08-05T00:00:00Z' },
        'node:24-alpine': { bytes: 60_000_000, updatedAt: '2026-08-05T00:00:00Z' },
      }),
    });

    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toMatchObject({ image: 'node', tag: '24-alpine', bytes: 60_000_000 });
  });

  it('says so when a tag stops being published, and keeps the last reading', async () => {
    const held = [
      { image: 'node', tag: '24-alpine', bytes: 60_000_000, updatedAt: '2026-01-01T00:00:00Z', observedAt: NOW },
    ];

    const result = await collectImages(held, {
      now: NOW,
      delayMs: 0,
      tracked,
      client: client({ 'node:24': { bytes: 409_000_000, updatedAt: '2026-08-05T00:00:00Z' } }),
    });

    expect(result.rows).toContainEqual(held[0]);
    expect(result.errors[0]).toContain('no longer published');
  });
});

// ------------------------------------------------------------------ questions

describe('whether anybody is still asking', () => {
  function client(totals: Record<string, number>): QuestionClient {
    let spent = 0;
    return {
      requests: () => spent,
      async total(tag) {
        spent += 1;
        // Two calls per tag: the recent window, then the earlier one.
        return spent % 2 === 1 ? (totals[tag] ?? 0) : (totals[`${tag}-was`] ?? 0);
      },
    };
  }

  it('reads two equal windows and stores both', async () => {
    const result = await collectQuestions([], {
      today: TODAY,
      delayMs: 0,
      tags: ['rust'],
      client: client({ rust: 24, 'rust-was': 40 }),
    });

    // Both windows, not a computed change: nobody can check a delta, and a fall
    // from four to two is a fifty percent collapse that means nothing.
    expect(result.rows[0]).toMatchObject({ tag: 'rust', recent: 24, earlier: 40 });
  });

  it('reads a tag against the median tag, not against its own past', () => {
    const rows = [
      { tag: 'a', windowDays: 30, recent: 50, earlier: 100, observedAt: TODAY },
      { tag: 'b', windowDays: 30, recent: 75, earlier: 100, observedAt: TODAY },
      { tag: 'c', windowDays: 30, recent: 90, earlier: 100, observedAt: TODAY },
    ];

    const summary = summariseQuestions(rows);

    // Every tag fell. Only the comparison between them says anything, because
    // volume has fallen across nearly every tag on the site.
    expect(summary.medianChange).toBe(-25);
    expect(summary.holding[0]?.tag).toBe('c');
    expect(summary.fading[0]?.tag).toBe('a');
  });

  it('refuses a percentage on a sample too small to carry one', () => {
    const summary = summariseQuestions([
      { tag: 'tiny', windowDays: 30, recent: 2, earlier: MIN_BASE - 1, observedAt: TODAY },
    ]);

    expect(summary.busiest[0]?.change).toBe(null);
    expect(summary.busiest[0]?.vsMedian).toBe(null);
  });

  it('keeps the last reading when a window is unreadable', async () => {
    const held = [{ tag: 'rust', windowDays: 30, recent: 99, earlier: 88, observedAt: '2026-08-01' }];
    const broken: QuestionClient = {
      requests: () => 1,
      async total() {
        return null;
      },
    };

    const result = await collectQuestions(held, {
      today: TODAY,
      delayMs: 0,
      tags: ['rust'],
      client: broken,
    });

    expect(result.rows).toEqual(held);
    expect(result.errors[0]).toContain('unreadable');
  });
});
