import { describe, expect, it } from 'vitest';

import {
  collectAdoption,
  parsePackageId,
  recordAdoption,
} from '../src/collectors/adoption.ts';
import { npmBatches, NPM_BATCH } from '../src/lib/registries.ts';
import type { RegistryClient } from '../src/lib/registries.ts';
import type { AdoptionRow } from '../src/types/adoption.ts';
import type { WatchlistEntry } from '../src/types/watchlist.ts';

/**
 * The second axis. Everything else here reads GitHub, which measures what
 * people build and says nothing about whether anyone ran it — and a wrong
 * mapping would attribute one project's adoption to another, silently, with a
 * number that looks perfectly plausible. So the edges get tested: a registry
 * down, a package delisted, a count that never moves.
 */

const NOW = '2026-08-06T02:17:00.000Z';

function entry(id: string, packages: string[], active = true): WatchlistEntry {
  return { id, category: 'devtool', added: '2026-07-01', active, packages };
}

function stub(over: Partial<RegistryClient> = {}): RegistryClient {
  return {
    npmDownloads: async () => new Map(),
    brewInstalls: async () => new Map(),
    pypiDownloads: async () => null,
    cratesDownloads: async () => null,
    requests: () => 0,
    ...over,
  };
}

describe('package identifiers', () => {
  it('reads registry and name apart', () => {
    expect(parsePackageId('npm:react')).toEqual({ registry: 'npm', name: 'react' });
    // Scoped names contain a slash and no second colon.
    expect(parsePackageId('npm:@types/node')).toEqual({ registry: 'npm', name: '@types/node' });
  });

  it('refuses anything it does not recognise', () => {
    // A bare name would silently pick a registry, and picking wrong attributes
    // one ecosystem's downloads to another.
    expect(parsePackageId('react')).toBeNull();
    expect(parsePackageId('maven:junit')).toBeNull();
    expect(parsePackageId('npm:')).toBeNull();
  });
});

describe('npm batching', () => {
  it('never puts more in a request than npm accepts', () => {
    // Verified against the live service: 128 succeeds and 129 returns 400.
    const names = Array.from({ length: 300 }, (_, i) => `pkg-${i}`);
    const { batched } = npmBatches(names);
    expect(batched.every((batch) => batch.length <= NPM_BATCH)).toBe(true);
    expect(batched.flat()).toHaveLength(300);
  });

  it('takes scoped names out of the batch, because npm rejects them there', () => {
    const { batched, single } = npmBatches(['react', '@types/node', 'vue']);
    expect(batched.flat()).toEqual(['react', 'vue']);
    expect(single).toEqual(['@types/node']);
  });
});

describe('the trend', () => {
  it('keeps one reading a day, so a re-run cannot inflate it', () => {
    const first = recordAdoption([], '2026-08-06T02:17:00.000Z', 100);
    const again = recordAdoption(first, '2026-08-06T06:17:00.000Z', 100);

    expect(again).toHaveLength(1);
    expect(again[0]?.count).toBe(100);
    expect(again[0]?.at).toBe('2026-08-06T06:17:00.000Z');
  });

  it('records a flat week, because a flat week is the measurement', () => {
    // Unlike a fork count, an unchanged download figure is information. Dropping
    // it would make a dead package look like one nobody read this week.
    const monday = recordAdoption([], '2026-08-03T02:17:00.000Z', 500);
    const tuesday = recordAdoption(monday, '2026-08-04T02:17:00.000Z', 500);

    expect(tuesday).toHaveLength(2);
  });

  it('stays bounded', () => {
    let samples = recordAdoption([], '2026-06-01T02:17:00.000Z', 1);
    for (let day = 2; day <= 70; day += 1) {
      const at = new Date(Date.UTC(2026, 5, day, 2, 17)).toISOString();
      samples = recordAdoption(samples, at, day);
    }
    expect(samples.length).toBeLessThanOrEqual(36);
  });
});

describe('collecting', () => {
  it('reads each registry and keeps the units apart', async () => {
    // An npm week and a Homebrew month are different measurements. Summing them
    // would produce a number that means nothing.
    const result = await collectAdoption(
      [entry('a/one', ['npm:one', 'brew:one'])],
      [],
      {
        now: NOW,
        client: stub({
          npmDownloads: async () => new Map([['one', 900]]),
          brewInstalls: async () => new Map([['one', 40]]),
        }),
      },
    );

    const npm = result.rows.find((row) => row.registry === 'npm');
    const brew = result.rows.find((row) => row.registry === 'brew');

    expect(npm?.count).toBe(900);
    expect(npm?.window).toBe('week');
    expect(brew?.count).toBe(40);
    expect(brew?.window).toBe('30d');
  });

  it('carries the last reading forward when a registry cannot be read', async () => {
    // Writing null would say the package vanished. Writing zero would be worse.
    const previous: AdoptionRow[] = [
      { id: 'a/one', registry: 'npm', name: 'one', count: 900, window: 'week', samples: [] },
    ];

    const result = await collectAdoption([entry('a/one', ['npm:one'])], previous, {
      now: NOW,
      client: stub(),
    });

    expect(result.rows[0]?.count).toBe(900);
    expect(result.rows[0]?.samples).toHaveLength(0);
    expect(result.missed).toContain('npm');
  });

  it('reports an unmappable identifier instead of guessing at it', async () => {
    const result = await collectAdoption([entry('a/one', ['maven:junit'])], [], {
      now: NOW,
      client: stub(),
    });

    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]).toContain('not a known registry:name pair');
  });

  it('attributes a shared package to every repository that claims it', async () => {
    // A monorepo split across watchlist entries is legitimate, and the reading
    // is fetched once regardless.
    const result = await collectAdoption(
      [entry('a/one', ['npm:shared']), entry('b/two', ['npm:shared'])],
      [],
      { now: NOW, client: stub({ npmDownloads: async () => new Map([['shared', 10]]) }) },
    );

    expect(result.rows.map((row) => row.id).sort()).toEqual(['a/one', 'b/two']);
    expect(result.rows.every((row) => row.count === 10)).toBe(true);
  });

  it('spends nothing on a retired repository', async () => {
    let asked = 0;
    const result = await collectAdoption([entry('a/one', ['npm:one'], false)], [], {
      now: NOW,
      client: stub({
        npmDownloads: async () => {
          asked += 1;
          return new Map();
        },
      }),
    });

    expect(asked).toBe(0);
    expect(result.rows).toHaveLength(0);
  });
});
