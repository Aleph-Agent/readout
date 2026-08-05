import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createGitHubClient } from '../src/lib/github.ts';
import type { WatchlistEntry } from '../src/types/watchlist.ts';

/**
 * The dry run, offline.
 *
 * Prompt 2's definition of done is that a second run costs far fewer requests
 * than the first. That is a claim about conditional requests, and it can be
 * proven exactly against a stub that speaks the same protocol GitHub does —
 * without a token, without network flakiness, and on every future commit.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'signal-pulse-'));
process.env['SIGNAL_DATA_DIR'] = dataDir;

const ledger = await import('../src/lib/ledger.ts');
const { runPulse } = await import('../src/jobs/pulse.ts');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env['SIGNAL_DATA_DIR'];
});

const REPOS = 20;

function seedWatchlist(): void {
  const entries: WatchlistEntry[] = Array.from({ length: REPOS }, (_, i) => ({
    id: `owner${String(i).padStart(2, '0')}/repo`,
    category: 'devtool',
    added: '2026-08-04',
    active: true,
  }));
  ledger.writeWatchlist(entries);
}

/** A stub that implements ETag validation the way GitHub does. */
function makeServer() {
  let releaseTag = 'v1.0.0';
  let requests = 0;

  const impl = (async (input: string | URL, init?: RequestInit) => {
    requests += 1;
    const url = String(input);
    const isRelease = url.endsWith('/releases/latest');
    const etag = isRelease ? `W/"${url}:${releaseTag}"` : `W/"${url}"`;

    const sent = new Headers(init?.headers).get('if-none-match');
    const headers = new Headers({ 'x-ratelimit-remaining': '4999', etag });

    if (sent === etag) return new Response(null, { status: 304, headers });

    const body = isRelease
      ? {
          tag_name: releaseTag,
          name: null,
          published_at: '2026-08-01T00:00:00Z',
          html_url: `https://github.com/${url}/releases/tag/${releaseTag}`,
          draft: false,
          prerelease: false,
        }
      : {
          full_name: 'owner/repo',
          forks_count: 10,
          stargazers_count: 100,
          open_issues_count: 3,
          pushed_at: '2026-08-04T00:00:00Z',
        };

    return new Response(JSON.stringify(body), { status: 200, headers });
  }) as unknown as typeof fetch;

  return {
    impl,
    requests: () => requests,
    publish: (tag: string) => {
      releaseTag = tag;
    },
  };
}

const server = makeServer();

function pulse(now: string) {
  return runPulse({
    client: createGitHubClient({ token: 'stub', fetchImpl: server.impl }),
    now: new Date(now),
    limit: REPOS,
  });
}

describe('pulse dry run', () => {
  it('collects the whole slice on a cold start', async () => {
    seedWatchlist();
    const meta = await pulse('2026-08-04T04:17:00Z');

    // Two endpoints per repository: base, then releases.
    expect(meta.requestsConsumed).toBe(REPOS * 2);
    expect(meta.requestsUnchanged).toBe(0);
    expect(meta.reposChecked).toBe(REPOS);
    expect(ledger.readLiveState()).toHaveLength(REPOS);
  });

  it('emits no release events on first observation', async () => {
    // Every repository looks like it "just released" the first time it is seen.
    // Emitting here would manufacture 400 headlines out of ordinary history.
    expect(ledger.readEvents('2026-08')).toHaveLength(0);
    expect(ledger.readLiveState()[0]?.latestReleaseTag).toBe('v1.0.0');
  });

  it('spends nothing on a second run because everything answered 304', async () => {
    const meta = await pulse('2026-08-04T08:17:00Z');

    expect(meta.requestsConsumed).toBe(0);
    expect(meta.requestsUnchanged).toBe(REPOS * 2);
    // The bar Prompt 2 sets is under 25. Conditional requests make it zero.
    expect(meta.requestsConsumed).toBeLessThan(25);
  });

  it('keeps every unchanged row byte-identical across runs', async () => {
    const before = ledger.readLiveState();
    await pulse('2026-08-04T12:17:00Z');
    expect(ledger.readLiveState()).toEqual(before);
  });

  it('detects a real release once the tag actually moves', async () => {
    server.publish('v1.1.0');
    const meta = await pulse('2026-08-04T16:17:00Z');

    expect(meta.eventsDetected).toBe(REPOS);
    expect(meta.requestsConsumed).toBe(REPOS); // base still 304s; only releases refetch

    const events = ledger.readEvents('2026-08');
    expect(events).toHaveLength(REPOS);

    const event = events[0];
    expect(event?.kind).toBe('release');
    expect(event?.confidence).toBe('confirmed');
    // Releases never queue for prose: the templated sentence already states the
    // repository, the tag, the previous tag and the day, which is all a release
    // is. Run against real data the model returned that same sentence minus the
    // date.
    expect(event?.summaryState).toBe('skipped');
    expect(event?.summary).toBeNull();
    expect(event?.evidenceUrl).toContain('/releases/tag/v1.1.0');
    expect(event?.metrics['previousTag']).toBe('v1.0.0');
  });

  it('gives a repository one release slot per day however many tags it pushes', async () => {
    // A CI loop retagging twenty times must not own the entire feed.
    server.publish('v1.1.1');
    const meta = await pulse('2026-08-04T20:17:00Z');

    expect(meta.eventsDetected).toBe(0);
    expect(ledger.readEvents('2026-08')).toHaveLength(REPOS);
  });

  it('keeps a limited run limited on both endpoints', async () => {
    // base carries forward every previously known row. Handing those to the
    // release collector would make --limit=20 quietly hit four hundred release
    // endpoints on a full watchlist.
    ledger.writeWatchlist([
      ...ledger.readWatchlist(),
      { id: 'zz-extra/repo', category: 'devtool', added: '2026-08-04', active: true },
    ]);

    server.publish('v2.0.0');
    const meta = await pulse('2026-08-05T00:17:00Z');

    // Two calls for the one repository inside the limit, and nothing for the
    // twenty carried-forward rows beyond it.
    expect(meta.requestsConsumed + meta.requestsUnchanged).toBeLessThanOrEqual(REPOS * 2);
  });

  it('drops state rows for repositories removed from the watchlist', async () => {
    const trimmed = ledger.readWatchlist().filter((entry) => entry.id !== 'owner00/repo');
    ledger.writeWatchlist(trimmed);

    await pulse('2026-08-05T04:17:00Z');

    expect(ledger.readLiveState().map((row) => row.id)).not.toContain('owner00/repo');
  });

  it('records the run in meta rather than in every state row', async () => {
    const meta = ledger.readMeta();
    expect(meta.job).toBe('pulse');
    expect(meta.lastRunAt).toBe('2026-08-05T04:17:00.000Z');
    expect(meta.partial).toBe(false);
  });
});
