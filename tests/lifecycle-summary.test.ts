import { describe, expect, it } from 'vitest';

import { HORIZON_DAYS, SOON_LIMIT, summariseLifecycle } from '../src/lib/lifecycle-summary.ts';
import type { LifecycleRow } from '../src/types/lifecycle.ts';

const TODAY = '2026-08-07';

function row(over: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    product: 'python',
    cycle: '3.9',
    eol: '2026-10-31',
    ended: false,
    latest: '3.9.20',
    lts: false,
    observedAt: '2026-08-07T02:17:00.000Z',
    ...over,
  };
}

describe('summariseLifecycle', () => {
  it('counts what is dated, ended and approaching', () => {
    const summary = summariseLifecycle(
      [
        row({ cycle: '3.9', eol: '2026-10-31' }),
        row({ cycle: '3.8', eol: '2024-10-07', ended: true }),
        row({ cycle: '3.14', eol: '2031-10-31' }),
        row({ product: 'go', cycle: '1.24', eol: null }),
      ],
      TODAY,
    );

    expect(summary).toMatchObject({ products: 2, dated: 3, ended: 1, approaching: 1 });
    expect(summary.soon.map((reading) => reading.cycle)).toEqual(['3.9']);
    expect(summary.soon[0]?.days).toBe(85);
  });

  it('orders by how soon, not alphabetically', () => {
    const summary = summariseLifecycle(
      [
        row({ product: 'redis', cycle: '7', eol: '2027-01-01' }),
        row({ product: 'nodejs', cycle: '20', eol: '2026-09-01' }),
        row({ product: 'alpine', cycle: '3.18', eol: '2026-12-01' }),
      ],
      TODAY,
    );

    expect(summary.soon.map((reading) => reading.product)).toEqual(['nodejs', 'alpine', 'redis']);
  });

  it('excludes dates already passed from the countdown', () => {
    const summary = summariseLifecycle([row({ eol: '2026-08-06' })], TODAY);

    expect(summary.approaching).toBe(0);
    expect(summary.soon).toEqual([]);
    // Still counted as dated. The date exists; it is simply behind us.
    expect(summary.dated).toBe(1);
  });

  it('stops at the horizon', () => {
    const inside = new Date(Date.parse(`${TODAY}T00:00:00Z`) + HORIZON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const outside = new Date(Date.parse(`${TODAY}T00:00:00Z`) + (HORIZON_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const summary = summariseLifecycle(
      [row({ cycle: 'in', eol: inside }), row({ cycle: 'out', eol: outside })],
      TODAY,
    );

    expect(summary.soon.map((reading) => reading.cycle)).toEqual(['in']);
  });

  it('bounds the table', () => {
    const rows = Array.from({ length: SOON_LIMIT + 6 }, (_, i) =>
      row({ cycle: String(i), eol: '2026-10-31' }),
    );

    expect(summariseLifecycle(rows, TODAY).soon).toHaveLength(SOON_LIMIT);
    expect(summariseLifecycle(rows, TODAY).approaching).toBe(SOON_LIMIT + 6);
  });

  it('sorts supported cycles as versions, not as text', () => {
    const summary = summariseLifecycle(
      [
        row({ product: 'nodejs', cycle: '9', eol: null }),
        row({ product: 'nodejs', cycle: '10', eol: null }),
        row({ product: 'nodejs', cycle: '24', eol: null }),
      ],
      TODAY,
    );

    // String order would put 9 first, and a page saying Node 9 is the newest
    // supported release is worse than no page.
    expect(summary.supported[0]?.cycles).toEqual(['24', '10', '9']);
  });

  it('leaves an ended cycle out of what to move to', () => {
    const summary = summariseLifecycle(
      [
        row({ cycle: '3.8', ended: true, eol: '2024-10-07' }),
        row({ cycle: '3.13', ended: false, eol: '2029-10-31', latest: '3.13.7' }),
      ],
      TODAY,
    );

    expect(summary.supported).toEqual([
      { product: 'python', cycles: ['3.13'], latest: '3.13.7' },
    ]);
  });

  it('omits a product whose every cycle has ended rather than listing it empty', () => {
    const summary = summariseLifecycle(
      [row({ product: 'angularjs', cycle: '1.8', ended: true, eol: '2022-01-01' })],
      TODAY,
    );

    expect(summary.products).toBe(1);
    expect(summary.supported).toEqual([]);
  });

  it('reads nothing as nothing', () => {
    expect(summariseLifecycle([], TODAY)).toEqual({
      products: 0,
      dated: 0,
      ended: 0,
      approaching: 0,
      soon: [],
      supported: [],
    });
  });
});
