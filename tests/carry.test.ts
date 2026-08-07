import { describe, expect, it } from 'vitest';

import { keepOrCarry, MIN_SHARE } from '../src/lib/carry.ts';

/**
 * The guard these collectors had was `rows.length === 0 ? held : rows`, which
 * only ever caught total silence. Every test below is a run that guard would
 * have waved through while the ledger lost most of its contents.
 */

const held = Array.from({ length: 100 }, (_, index) => ({ id: index }));

describe('a partial outage', () => {
  it('is refused, which the old zero-check never did', () => {
    // 20 successful reads out of 100 is a count greater than zero, so the old
    // guard passed and deleted 80 rows. The site then reported that it watches
    // 20 packages, in its own voice, with no error anywhere.
    const result = keepOrCarry('adoption', held.slice(0, 20), held);

    expect(result.carried).toBe(true);
    expect(result.rows).toHaveLength(100);
  });

  it('says how much was read, so somebody can act on it', () => {
    const result = keepOrCarry('adoption', held.slice(0, 20), held);

    expect(result.error).toContain('adoption');
    expect(result.error).toContain('20 of 100');
  });

  it('still catches total silence', () => {
    const result = keepOrCarry('incidents', [], held);

    expect(result.rows).toHaveLength(100);
    expect(result.error).toContain('read nothing');
  });
});

describe('a run that worked', () => {
  it('writes the fresh reading', () => {
    const fresh = Array.from({ length: 100 }, (_, index) => ({ id: index + 1000 }));
    const result = keepOrCarry('adoption', fresh, held);

    expect(result.rows).toBe(fresh);
    expect(result.error).toBeNull();
    expect(result.carried).toBe(false);
  });

  it('allows a ledger to shrink, just not to collapse', () => {
    // Packages get retired and watchlist entries get withdrawn by commit. A
    // guard that refused every shrink would block ordinary maintenance.
    const result = keepOrCarry('staleness', held.slice(0, 80), held);

    expect(result.carried).toBe(false);
    expect(result.rows).toHaveLength(80);
  });

  it('draws the line at exactly half', () => {
    expect(keepOrCarry('x', held.slice(0, 50), held).carried).toBe(false);
    expect(keepOrCarry('x', held.slice(0, 49), held).carried).toBe(true);
    expect(MIN_SHARE).toBe(0.5);
  });
});

describe('the first run', () => {
  it('writes whatever it read, because there is nothing to protect', () => {
    // An empty ledger cannot be damaged, and refusing a partial first reading
    // would leave the file empty forever — the guard would prevent the very
    // thing it exists to preserve.
    const result = keepOrCarry('images', held.slice(0, 3), []);

    expect(result.rows).toHaveLength(3);
    expect(result.error).toBeNull();
  });

  it('is not fooled into carrying an empty ledger forward', () => {
    const result = keepOrCarry('images', [], []);

    expect(result.rows).toHaveLength(0);
    expect(result.error).toBeNull();
  });
});
