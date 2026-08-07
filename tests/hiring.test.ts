import { describe, expect, it } from 'vitest';

import {
  collectHiring,
  countTerms,
  TERMS,
  toText,
  type HiringClient,
} from '../src/collectors/hiring.ts';
import { MIN_MOVE, summariseHiring } from '../src/lib/hiring-summary.ts';
import type { HiringRow } from '../src/types/hiring.ts';

/**
 * What employers pay for, counted from one hiring thread a month.
 *
 * Two ways this goes wrong quietly. A loose pattern reports Go as the most
 * in-demand language on earth because "go to production" matched. And comparing
 * raw counts across two threads of different sizes publishes a trend that is
 * really a slower month.
 */

function client(threads: { id: string; month: string }[], posts: Record<string, string[]>): HiringClient {
  let spent = 0;
  return {
    requests: () => spent,
    async threads() {
      spent += 1;
      return threads;
    },
    async posts(id) {
      spent += 1;
      return posts[id] ?? [];
    },
  };
}

function row(over: Partial<HiringRow> = {}): HiringRow {
  return { month: '2026-08', term: 'Python', posts: 10, sample: 100, conservative: false, ...over };
}

describe('reading a post', () => {
  it('turns the escaped markup a comment arrives as back into words', () => {
    const html =
      'Acme (<a href="http:&#x2F;&#x2F;acme.co">acme.co</a>) | Rust &amp; Go | Full-time<p>We&#x27;re hiring';

    expect(toText(html)).toBe("Acme ( acme.co ) | Rust & Go | Full-time We're hiring");
  });
});

describe('matching a technology', () => {
  const match = (term: string, text: string): boolean =>
    countTerms([text], '2026-08').some((entry) => entry.term === term);

  it('counts a post once however often it names the thing', () => {
    const rows = countTerms(['React React React and more React'], '2026-08');
    expect(rows.find((entry) => entry.term === 'React')?.posts).toBe(1);
  });

  it('does not read ordinary English as Go', () => {
    // The failure this pattern exists to prevent. "go to" appears in most job
    // posts ever written, and a naive word boundary would crown Go.
    expect(match('Go', 'We want you to go to production on day one')).toBe(false);
    expect(match('Go', 'Backend in Golang')).toBe(true);
    expect(match('Go', 'Stack: Go, Postgres, Redis')).toBe(true);
    expect(match('Go', 'Looking for a Go engineer')).toBe(true);
  });

  it('declares the patterns that undercount rather than hiding it', () => {
    const conservative = TERMS.filter((entry) => entry.conservative === true).map(
      (entry) => entry.term,
    );

    expect(conservative).toContain('Go');
    // The flag has to reach the row, or the page cannot mark the number.
    expect(countTerms(['Golang shop'], '2026-08').find((e) => e.term === 'Go')?.conservative).toBe(
      true,
    );
    expect(countTerms(['Python shop'], '2026-08').find((e) => e.term === 'Python')?.conservative).toBe(
      false,
    );
  });

  it('keeps JavaScript out of the Java count', () => {
    expect(match('Java', 'Frontend in JavaScript')).toBe(false);
    expect(match('Java', 'Backend in Java 21')).toBe(true);
  });

  it('records the sample alongside every count', () => {
    // A count without its sample is not a rate, and this file is read alone.
    const rows = countTerms(['Python', 'Rust', 'nothing here'], '2026-08');
    expect(rows.every((entry) => entry.sample === 3)).toBe(true);
  });

  it('omits a term nobody named rather than writing a zero row', () => {
    const rows = countTerms(['Python only'], '2026-08');
    expect(rows.map((entry) => entry.term)).toEqual(['Python']);
  });
});

describe('collectHiring', () => {
  const threads = [
    { id: 'aug', month: '2026-08' },
    { id: 'jul', month: '2026-07' },
  ];

  it('reads the newest threads and counts each month separately', async () => {
    const result = await collectHiring([], {
      delayMs: 0,
      client: client(threads, { aug: ['Python and Rust'], jul: ['Python only'] }),
    });

    expect(result.errors).toEqual([]);
    expect(result.rows.filter((entry) => entry.month === '2026-08')).toHaveLength(2);
    expect(result.rows.filter((entry) => entry.month === '2026-07')).toHaveLength(1);
  });

  it('replaces the current month rather than adding to it', async () => {
    // The thread grows all month, so a re-read is the new truth for that month
    // and not another set of rows beside the old one.
    const held = [row({ month: '2026-08', term: 'Rust', posts: 1, sample: 10 })];
    const result = await collectHiring(held, {
      delayMs: 0,
      months: 1,
      client: client(threads, { aug: ['Python', 'Python'] }),
    });

    expect(result.rows.map((entry) => entry.term)).toEqual(['Python']);
    expect(result.rows[0]?.sample).toBe(2);
  });

  it('keeps every month already read when the search fails', async () => {
    const held = [row()];
    const broken: HiringClient = {
      requests: () => 1,
      async threads() {
        throw new Error('502');
      },
      async posts() {
        return [];
      },
    };

    const result = await collectHiring(held, { client: broken });
    expect(result.rows).toEqual(held);
    expect(result.errors[0]).toContain('hiring');
  });

  it('does not overwrite a complete month with an empty thread', async () => {
    // On the first of the month the new thread genuinely has no posts yet.
    const held = [row({ month: '2026-08', posts: 40, sample: 300 })];
    const result = await collectHiring(held, {
      delayMs: 0,
      months: 1,
      client: client(threads, { aug: [] }),
    });

    expect(result.rows).toEqual(held);
    expect(result.errors[0]).toContain('no posts read');
  });
});

describe('summariseHiring', () => {
  it('compares months by share, not by count', () => {
    // 40 of 400 and 30 of 200 — the count fell and the demand rose. Reading the
    // counts alone publishes exactly the wrong story.
    const summary = summariseHiring([
      row({ month: '2026-07', term: 'Rust', posts: 40, sample: 400 }),
      row({ month: '2026-08', term: 'Rust', posts: 30, sample: 200 }),
    ]);

    expect(summary.month).toBe('2026-08');
    expect(summary.top[0]).toMatchObject({ term: 'Rust', posts: 30, share: 15, move: 5 });
    expect(summary.rising.map((entry) => entry.term)).toEqual(['Rust']);
  });

  it('ignores a swing too small to mean anything in a few hundred posts', () => {
    const summary = summariseHiring([
      row({ month: '2026-07', term: 'Rust', posts: 100, sample: 1000 }),
      row({ month: '2026-08', term: 'Rust', posts: 101, sample: 1000 }),
    ]);

    expect(Math.abs(summary.top[0]?.move as number)).toBeLessThan(MIN_MOVE);
    expect(summary.rising).toEqual([]);
    expect(summary.falling).toEqual([]);
  });

  it('reports no movement for a term with no previous month', () => {
    const summary = summariseHiring([row({ month: '2026-08', term: 'Zig', posts: 3, sample: 100 })]);

    expect(summary.top[0]?.move).toBe(null);
    expect(summary.previousMonth).toBe(null);
  });

  it('carries the sample of both months so neither figure stands alone', () => {
    const summary = summariseHiring([
      row({ month: '2026-07', posts: 10, sample: 434 }),
      row({ month: '2026-08', posts: 10, sample: 284 }),
    ]);

    expect(summary.sample).toBe(284);
    expect(summary.previousSample).toBe(434);
  });

  it('reads an empty ledger as empty', () => {
    expect(summariseHiring([])).toMatchObject({ month: null, sample: 0, top: [] });
  });
});
