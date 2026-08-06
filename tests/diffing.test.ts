import { describe, expect, it } from 'vitest';

import { became, changed } from '../src/lib/diffing.ts';

/**
 * The rule that cost 232 published findings, twice, written down once.
 */

describe('changed', () => {
  it('reports a real transition', () => {
    expect(changed('MIT', 'BUSL-1.1')).toEqual({ from: 'MIT', to: 'BUSL-1.1' });
  });

  it('says nothing when the value held', () => {
    expect(changed('MIT', 'MIT')).toBeNull();
  });

  it('says nothing when the field was never recorded', () => {
    // The whole reason this file exists. A schema addition leaves every
    // existing row with undefined here, and comparing against it announced a
    // change for all 400 repositories on the watchlist.
    expect(changed(undefined, 'MIT')).toBeNull();
  });

  it('treats null as a recorded value, because it is one', () => {
    // null means read, and there was nothing there. Moving off it is real.
    expect(changed(null, 'MIT')).toEqual({ from: null, to: 'MIT' });
    expect(changed('MIT', null)).toEqual({ from: 'MIT', to: null });
    expect(changed(null, null)).toBeNull();
  });
});

describe('became', () => {
  it('reports a flag going true', () => {
    expect(became(false, true)).toBe(true);
  });

  it('says nothing when it was already true, or is still false', () => {
    expect(became(true, true)).toBe(false);
    expect(became(false, false)).toBe(false);
  });

  it('says nothing when the flag was never recorded', () => {
    // `!before.archived` reads as true for an absent field, so the plain
    // negation announces every archived repository the day the field lands.
    expect(became(undefined, true)).toBe(false);
  });
});
