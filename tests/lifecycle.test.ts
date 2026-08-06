import { describe, expect, it } from 'vitest';

import {
  collectLifecycle,
  daysUntil,
  WARN_DAYS,
  type LifecycleClient,
} from '../src/collectors/lifecycle.ts';
import type { LifecycleRow } from '../src/types/lifecycle.ts';

/**
 * The end-of-life clock.
 *
 * Two failure modes matter here and they point in opposite directions. A read
 * that fails must not look like a product that stopped existing, and a date
 * inside the window must be announced exactly once — a countdown repeated every
 * day for ninety days is a countdown nobody reads.
 */

const NOW = '2026-08-07T02:17:00.000Z';
const TODAY = '2026-08-07';

function options(over: Partial<Parameters<typeof collectLifecycle>[1]> = {}) {
  return { now: NOW, today: TODAY, seen: new Set<string>(), delayMs: 0, ...over };
}

/** A client serving fixed payloads, and counting what was asked for. */
function client(payloads: Record<string, unknown[] | null>, fail: string[] = []): LifecycleClient {
  let spent = 0;
  return {
    requests: () => spent,
    async cycles(product) {
      spent += 1;
      if (fail.includes(product)) throw new Error('network down');
      return (payloads[product] ?? null) as never;
    },
  };
}

function row(over: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    product: 'python',
    cycle: '3.9',
    eol: '2026-10-31',
    ended: false,
    latest: '3.9.20',
    lts: false,
    observedAt: '2026-08-01T02:17:00.000Z',
    ...over,
  };
}

describe('daysUntil', () => {
  it('counts forward and backward from a UTC day', () => {
    expect(daysUntil('2026-08-14', TODAY)).toBe(7);
    expect(daysUntil('2026-08-07', TODAY)).toBe(0);
    expect(daysUntil('2026-07-31', TODAY)).toBe(-7);
  });
});

describe('collectLifecycle', () => {
  it('records a cycle and announces a date inside the window', async () => {
    const result = await collectLifecycle(
      [],
      options({
        products: ['python'],
        client: client({ python: [{ cycle: '3.9', eol: '2026-09-30', latest: '3.9.20' }] }),
      }),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      product: 'python',
      cycle: '3.9',
      eol: '2026-09-30',
      ended: false,
      latest: '3.9.20',
      lts: false,
      observedAt: NOW,
    });

    expect(result.events).toHaveLength(1);
    const event = result.events[0] as NonNullable<(typeof result.events)[number]>;
    expect(event.kind).toBe('eol-approaching');
    expect(event.repo).toBe('python/3.9');
    expect(event.metrics['daysRemaining']).toBe(54);
    expect(event.evidenceUrl).toBe('https://endoflife.date/python');
    // Nothing here is a threshold crossing that could evaporate tomorrow.
    expect(event.confidence).toBe('confirmed');
  });

  it('says nothing about a date beyond the window', async () => {
    const result = await collectLifecycle(
      [],
      options({
        products: ['python'],
        client: client({ python: [{ cycle: '3.13', eol: '2030-10-31' }] }),
      }),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.events).toEqual([]);
  });

  it('announces once, not every day inside the window', async () => {
    const previous = [row({ eol: '2026-09-30' })];
    const result = await collectLifecycle(
      previous,
      options({
        products: ['python'],
        client: client({ python: [{ cycle: '3.9', eol: '2026-09-30' }] }),
      }),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.events).toEqual([]);
  });

  it('announces when a moved date brings a cycle into the window', async () => {
    const previous = [row({ eol: '2027-10-31' })];
    const result = await collectLifecycle(
      previous,
      options({
        products: ['python'],
        client: client({ python: [{ cycle: '3.9', eol: '2026-09-30' }] }),
      }),
    );

    expect(result.events).toHaveLength(1);
  });

  it('never announces the same day twice', async () => {
    const seen = new Set(['eol-approaching:python/3.9:2026-08-07']);
    const result = await collectLifecycle(
      [],
      options({
        products: ['python'],
        seen,
        client: client({ python: [{ cycle: '3.9', eol: '2026-09-30' }] }),
      }),
    );

    expect(result.events).toEqual([]);
  });

  it('marks a passed date ended and does not announce it', async () => {
    const result = await collectLifecycle(
      [],
      options({
        products: ['python'],
        client: client({ python: [{ cycle: '3.8', eol: '2024-10-07' }] }),
      }),
    );

    expect(result.rows[0]?.ended).toBe(true);
    expect(result.events).toEqual([]);
  });

  it('reads a boolean eol as a state, not a date', async () => {
    const result = await collectLifecycle(
      [],
      options({
        products: ['go'],
        client: client({
          go: [
            { cycle: '1.24', eol: false, latest: '1.24.2' },
            { cycle: '1.20', eol: true },
          ],
        }),
      }),
    );

    // Supported with no announced end is a real state, and it is neither
    // "ends on a date" nor "already over".
    expect(result.rows[0]).toMatchObject({ cycle: '1.24', eol: null, ended: false });
    expect(result.rows[1]).toMatchObject({ cycle: '1.20', eol: null, ended: true });
    expect(result.events).toEqual([]);
  });

  it('carries a product forward untouched when its read fails', async () => {
    const previous = [row(), row({ cycle: '3.10', eol: '2027-10-31' })];
    const result = await collectLifecycle(
      previous,
      options({ products: ['python'], client: client({}, ['python']) }),
    );

    expect(result.rows).toEqual(previous);
    expect(result.events).toEqual([]);
    expect(result.errors[0]).toContain('python');
  });

  it('does not confuse a prefix for a product when carrying rows forward', async () => {
    const previous = [row({ product: 'python' }), row({ product: 'python-alt', cycle: '1' })];
    const result = await collectLifecycle(
      previous,
      options({ products: ['python'], client: client({}, ['python']) }),
    );

    expect(result.rows).toEqual([previous[0]]);
  });

  it('reports a missing product as an error rather than an empty product', async () => {
    const result = await collectLifecycle(
      [],
      options({ products: ['nope'], client: client({ nope: null }) }),
    );

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(['lifecycle nope: not found']);
  });

  it('skips a cycle with no name rather than writing an empty key', async () => {
    const result = await collectLifecycle(
      [],
      options({
        products: ['python'],
        client: client({ python: [{ eol: '2026-09-30' }, { cycle: '3.9', eol: false }] }),
      }),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.cycle).toBe('3.9');
  });

  it('spends one request per product and no more', async () => {
    const c = client({ python: [], go: [], rust: [] });
    const result = await collectLifecycle([], options({ products: ['python', 'go', 'rust'], client: c }));

    expect(result.requests).toBe(3);
  });

  it('treats the window edge as inside it', async () => {
    const edge = new Date(Date.parse(`${TODAY}T00:00:00Z`) + WARN_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const result = await collectLifecycle(
      [],
      options({ products: ['python'], client: client({ python: [{ cycle: '3.9', eol: edge }] }) }),
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.metrics['daysRemaining']).toBe(WARN_DAYS);
  });
});
