import { describe, expect, it } from 'vitest';

import { collectHealth, type HealthClient } from '../src/collectors/health.ts';
import { ThrottledError } from '../src/lib/registries.ts';
import type { HealthRow } from '../src/types/health.ts';
import type { WatchlistEntry } from '../src/types/watchlist.ts';

/**
 * A refused read must never erase a recorded one.
 *
 * Found by audit, not by anything failing. This collector overwrites the whole
 * ledger every day and it used to write whatever it had just managed to read:
 * a refused scorecard replaced yesterday's score with null, and one failed OSV
 * batch blanked the advisory count for every repository in it at once.
 *
 * Nothing about that looks like a failure, which is why it survived. The row is
 * still written, the page still renders, and the figure becomes a dash — and a
 * dash on this site means "never scanned", so an outage at deps.dev would have
 * published, in this project's own voice, that a few hundred projects have no
 * security scorecard. The advisory case is worse: every project would have gone
 * to zero known advisories on the day OSV was unreachable.
 *
 * These tests are the shape of that failure held still.
 */

function entry(id: string, packages: string[] = []): WatchlistEntry {
  return { id, category: 'devtool', added: '2026-08-01', active: true, packages };
}

function client(overrides: Partial<HealthClient> = {}): HealthClient {
  return {
    scorecard: async () => null,
    advisories: async () => new Map(),
    requests: () => 0,
    ...overrides,
  };
}

const YESTERDAY: HealthRow[] = [
  {
    id: 'a/one',
    scorecard: 8.4,
    scoredAt: '2026-08-06',
    advisories: 3,
    observedAt: '2026-08-06T02:17:00Z',
  },
];

const NOW = '2026-08-07T02:17:00Z';

describe('a refused scorecard', () => {
  it('keeps the score that was already recorded', async () => {
    const result = await collectHealth([entry('a/one')], {
      now: NOW,
      previous: YESTERDAY,
      delayMs: 0,
      client: client({
        scorecard: async () => {
          throw new ThrottledError('deps.dev', 429);
        },
      }),
    });

    expect(result.rows[0]?.scorecard).toBe(8.4);
    expect(result.rows[0]?.scoredAt).toBe('2026-08-06');
  });

  it('still says it was refused, so the run is not reported as clean', async () => {
    // Carrying a figure forward silently would be its own bug: the page would
    // show a reading that is a day older than its timestamp claims.
    const result = await collectHealth([entry('a/one')], {
      now: NOW,
      previous: YESTERDAY,
      delayMs: 0,
      client: client({
        scorecard: async () => {
          throw new ThrottledError('deps.dev', 429);
        },
      }),
    });

    expect(result.errors.join(' ')).toContain('refused 1 of 1');
  });

  it('does not invent a score where there was never one', async () => {
    const result = await collectHealth([entry('b/two')], {
      now: NOW,
      previous: YESTERDAY,
      delayMs: 0,
      client: client({
        scorecard: async () => {
          throw new ThrottledError('deps.dev', 429);
        },
      }),
    });

    expect(result.rows[0]?.scorecard).toBeNull();
  });
});

describe('a scorecard that was genuinely never scanned', () => {
  it('is recorded as null, not carried forward', async () => {
    // The distinction the whole fix turns on. deps.dev answering "no scorecard"
    // is a reading; the request failing is not. Carrying forward on the first
    // would keep a stale score alive after a project's scan was withdrawn.
    const result = await collectHealth([entry('a/one')], {
      now: NOW,
      previous: YESTERDAY,
      delayMs: 0,
      client: client({ scorecard: async () => null }),
    });

    expect(result.rows[0]?.scorecard).toBeNull();
    expect(result.errors).toEqual([]);
  });
});

describe('a failed advisory batch', () => {
  it('does not report every project as suddenly clean', async () => {
    // The most dangerous way this could be wrong. One unreachable service, and
    // the site publishes that nothing has any known advisories.
    const result = await collectHealth([entry('a/one', ['npm:one'])], {
      now: NOW,
      previous: YESTERDAY,
      delayMs: 0,
      client: client({
        advisories: async () => {
          throw new Error('osv unreachable');
        },
      }),
    });

    expect(result.rows[0]?.advisories).toBe(3);
    expect(result.errors.join(' ')).toContain('osv');
  });

  it('records a real zero when the service answers zero', async () => {
    // Carrying forward on a successful read would make a fixed advisory
    // permanent, which is the same bug pointing the other way.
    const result = await collectHealth([entry('a/one', ['npm:one'])], {
      now: NOW,
      previous: YESTERDAY,
      delayMs: 0,
      client: client({ advisories: async () => new Map([['npm/one', 0]]) }),
    });

    expect(result.rows[0]?.advisories).toBe(0);
  });

  it('keeps the batches that did answer', async () => {
    // One refused request out of several must not discard the ones that
    // worked. A repository whose packages all came back has a complete count
    // and must be written as measured.
    const packages = Array.from({ length: 120 }, (_, index) => `npm:p${index}`);
    let call = 0;

    const result = await collectHealth([entry('a/one', packages), entry('b/two', ['npm:z'])], {
      now: NOW,
      previous: YESTERDAY,
      delayMs: 0,
      client: client({
        advisories: async (batch) => {
          call += 1;
          if (call === 1) throw new Error('osv refused the first batch');
          return new Map(batch.map((p) => [`${p.ecosystem}/${p.name}`, 1]));
        },
      }),
    });

    // a/one had packages in the failed batch, so its previous count stands.
    expect(result.rows.find((row) => row.id === 'a/one')?.advisories).toBe(3);
    // b/two was entirely in a batch that answered, so it is measured.
    expect(result.rows.find((row) => row.id === 'b/two')?.advisories).toBe(1);
  });
});

describe('without any previous rows', () => {
  it('behaves as it always did rather than throwing', async () => {
    // The first run ever, and every test written before the carry-forward
    // existed. Absent previous state is not an error.
    const result = await collectHealth([entry('a/one')], {
      now: NOW,
      delayMs: 0,
      client: client({ scorecard: async () => ({ score: 5, at: '2026-08-07' }) }),
    });

    expect(result.rows[0]?.scorecard).toBe(5);
  });
});
