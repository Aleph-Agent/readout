import { describe, expect, it } from 'vitest';

import {
  collectIncidents,
  parseFeed,
  PROVIDERS,
  type IncidentClient,
} from '../src/collectors/incidents.ts';
import { summariseIncidents, WINDOW_DAYS } from '../src/lib/incidents-summary.ts';
import type { IncidentRow } from '../src/types/incidents.ts';

/**
 * Incident history read from other people's status feeds.
 *
 * The dangerous failure here is quiet: every feed is a rolling window, so a
 * read that returns nothing looks exactly like a provider with a spotless
 * quarter. Emptying the ledger on one of those would delete the only copy of a
 * record that no longer exists anywhere else.
 */

const TODAY = '2026-08-07';

function feed(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Whoever - Incident History</title>${items}</channel></rss>`;
}

function item(over: { title?: string; date?: string; link?: string; resolved?: boolean } = {}): string {
  const resolved = over.resolved ?? true;
  return `<item>
    <title>${over.title ?? 'Incident with Actions'}</title>
    <description>&lt;p&gt;&lt;strong&gt;${resolved ? 'Resolved' : 'Investigating'}&lt;/strong&gt; - words&lt;/p&gt;</description>
    <pubDate>${over.date ?? 'Fri, 07 Aug 2026 02:04:44 +0000'}</pubDate>
    <link>${over.link ?? 'https://example.test/incidents/1'}</link>
  </item>`;
}

function client(payloads: Record<string, string | null>, fail: string[] = []): IncidentClient {
  let spent = 0;
  return {
    requests: () => spent,
    async feed(url) {
      spent += 1;
      if (fail.includes(url)) throw new Error('socket hang up');
      return payloads[url] ?? null;
    },
  };
}

const ONE = [{ slug: 'whoever', name: 'Whoever', feed: 'https://status.test/history.rss' }];

function options(over: Partial<Parameters<typeof collectIncidents>[1]> = {}) {
  return { today: TODAY, delayMs: 0, providers: ONE, ...over };
}

function row(over: Partial<IncidentRow> = {}): IncidentRow {
  return {
    provider: 'whoever',
    id: 'https://example.test/incidents/1',
    title: 'Incident with Actions',
    startedAt: '2026-08-01T02:04:44.000Z',
    resolved: true,
    url: 'https://example.test/incidents/1',
    ...over,
  };
}

describe('parseFeed', () => {
  it('reads title, date, link and the provider’s own resolution', () => {
    const rows = parseFeed(feed(item()), 'whoever');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'whoever',
      title: 'Incident with Actions',
      startedAt: '2026-08-07T02:04:44.000Z',
      resolved: true,
      url: 'https://example.test/incidents/1',
    });
  });

  it('records an open incident as unresolved rather than guessing', () => {
    // Covers both "still going" and "never closed out". Those are different,
    // and this cannot tell them apart, so it claims neither.
    expect(parseFeed(feed(item({ resolved: false })), 'whoever')[0]?.resolved).toBe(false);
  });

  it('unescapes the entities the feed arrives with', () => {
    const rows = parseFeed(
      feed(item({ title: 'Elevated errors &amp; latency on &lt;api&gt;' })),
      'whoever',
    );

    expect(rows[0]?.title).toBe('Elevated errors & latency on <api>');
  });

  it('skips an item with no usable date instead of inventing one', () => {
    const broken = `<item><title>No date</title><link>https://example.test/x</link></item>`;
    const nonsense = `<item><title>Bad date</title><pubDate>whenever</pubDate><link>https://example.test/y</link></item>`;

    expect(parseFeed(feed(broken + nonsense + item()), 'whoever')).toHaveLength(1);
  });

  it('returns nothing for a page that is not a feed', () => {
    // Heroku and Railway both answer their /history.rss with HTML and a 200.
    expect(parseFeed('<!DOCTYPE html><html><body>Status</body></html>', 'whoever')).toEqual([]);
  });
});

describe('collectIncidents', () => {
  it('keeps an incident the feed has already dropped', async () => {
    // The entire reason the file exists. Statuspage carries about 25 items and
    // forgets the rest, so outliving that window is the only thing added here.
    const held = [row({ id: 'old', startedAt: '2026-06-01T00:00:00.000Z' })];
    const result = await collectIncidents(
      held,
      options({ client: client({ 'https://status.test/history.rss': feed(item()) }) }),
    );

    expect(result.rows.map((entry) => entry.id).sort()).toEqual([
      'https://example.test/incidents/1',
      'old',
    ]);
  });

  it('updates an incident in place when its resolution lands later', async () => {
    const held = [row({ resolved: false })];
    const result = await collectIncidents(
      held,
      options({
        client: client({
          'https://status.test/history.rss': feed(item({ date: 'Sat, 01 Aug 2026 02:04:44 +0000' })),
        }),
      }),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.resolved).toBe(true);
  });

  it('keeps what it has when a feed cannot be read', async () => {
    const held = [row()];
    const result = await collectIncidents(
      held,
      options({ client: client({}, ['https://status.test/history.rss']) }),
    );

    expect(result.rows).toEqual(held);
    expect(result.errors[0]).toContain('whoever');
  });

  it('keeps what it has when a feed stops being a feed', async () => {
    const held = [row()];
    const result = await collectIncidents(
      held,
      options({ client: client({ 'https://status.test/history.rss': '<html></html>' }) }),
    );

    expect(result.rows).toEqual(held);
    expect(result.errors[0]).toContain('no items parsed');
  });

  it('drops rows past the retention window', async () => {
    const held = [
      row({ id: 'ancient', startedAt: '2020-01-01T00:00:00.000Z' }),
      row({ id: 'recent', startedAt: '2026-08-01T00:00:00.000Z' }),
    ];

    const result = await collectIncidents(
      held,
      options({ retainDays: 365, client: client({ 'https://status.test/history.rss': feed(item()) }) }),
    );

    expect(result.rows.map((entry) => entry.id)).not.toContain('ancient');
    expect(result.rows.map((entry) => entry.id)).toContain('recent');
  });

  it('spends one request per provider', async () => {
    const c = client({});
    await collectIncidents([], options({ client: c, providers: PROVIDERS, delayMs: 0 }));
    expect(c.requests()).toBe(PROVIDERS.length);
  });
});

describe('summariseIncidents', () => {
  it('counts inside the window and names every tracked provider', () => {
    const summary = summariseIncidents(
      [
        { ...row({ provider: 'github', startedAt: '2026-08-06T00:00:00.000Z', id: 'a' }) },
        { ...row({ provider: 'github', startedAt: '2026-08-05T00:00:00.000Z', id: 'b' }) },
        { ...row({ provider: 'npm', startedAt: '2026-08-04T00:00:00.000Z', id: 'c' }) },
        // Outside the window.
        { ...row({ provider: 'npm', startedAt: '2025-01-01T00:00:00.000Z', id: 'd' }) },
      ],
      TODAY,
    );

    expect(summary.total).toBe(3);
    expect(summary.windowDays).toBe(WINDOW_DAYS);
    expect(summary.providers).toBe(PROVIDERS.length);
    // Quiet providers are listed at zero rather than omitted. An absent row
    // reads as "not watched", which is a different claim from "nothing filed".
    expect(summary.byProvider).toHaveLength(PROVIDERS.length);
    expect(summary.byProvider[0]).toMatchObject({ slug: 'github', count: 2 });
  });

  it('orders by count, busiest first', () => {
    const summary = summariseIncidents(
      [
        row({ provider: 'npm', id: 'a', startedAt: '2026-08-06T00:00:00.000Z' }),
        row({ provider: 'npm', id: 'b', startedAt: '2026-08-06T00:00:00.000Z' }),
        row({ provider: 'npm', id: 'c', startedAt: '2026-08-06T00:00:00.000Z' }),
        row({ provider: 'github', id: 'd', startedAt: '2026-08-06T00:00:00.000Z' }),
      ],
      TODAY,
    );

    expect(summary.byProvider[0]?.slug).toBe('npm');
    expect(summary.byProvider[1]?.slug).toBe('github');
  });

  it('reports how far back the record actually goes', () => {
    // Stops the page implying a longer history than has been kept.
    const summary = summariseIncidents(
      [row({ provider: 'github', startedAt: '2026-07-08T00:00:00.000Z' })],
      TODAY,
    );

    expect(summary.observedDays).toBe(30);
  });

  it('reads an empty ledger as empty rather than throwing', () => {
    const summary = summariseIncidents([], TODAY);

    expect(summary.total).toBe(0);
    expect(summary.observedDays).toBe(0);
    expect(summary.recent).toEqual([]);
    expect(summary.byProvider.every((entry) => entry.count === 0)).toBe(true);
  });
});
