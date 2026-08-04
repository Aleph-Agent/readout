import { describe, expect, it, vi } from 'vitest';

import {
  BudgetExhaustedError,
  createGitHubClient,
  SecondaryRateLimitError,
} from '../src/lib/github.ts';

const TOKEN = 'ghp-not-a-real-token';

function response(
  body: unknown,
  init: { status?: number; etag?: string; remaining?: string; retryAfter?: string } = {},
): Response {
  const headers = new Headers();
  headers.set('x-ratelimit-remaining', init.remaining ?? '4999');
  if (init.etag !== undefined) headers.set('etag', init.etag);
  if (init.retryAfter !== undefined) headers.set('retry-after', init.retryAfter);

  const status = init.status ?? 200;
  const payload = status === 304 ? null : JSON.stringify(body);
  return new Response(payload, { status, headers });
}

function client(fetchImpl: typeof fetch, over: { floor?: number } = {}) {
  return createGitHubClient({
    token: TOKEN,
    fetchImpl,
    sleep: async () => {},
    ...over,
  });
}

describe('createGitHubClient', () => {
  it('refuses an empty token', () => {
    // Unauthenticated calls are capped at 60/hour and exhaust in seconds.
    expect(() => createGitHubClient({ token: '' })).toThrow(/unauthenticated/);
  });

  it('names the problem when a token carries a byte order mark', () => {
    // This is not hypothetical: a BOM survived into the secret and every one of
    // twenty repositories failed with "character at index 7 has a value of
    // 65279", which describes the symptom and not the cause.
    expect(() => createGitHubClient({ token: `﻿${TOKEN}` })).toThrow(/byte order mark/);
    expect(() => createGitHubClient({ token: `${TOKEN}\n` })).toThrow(/HTTP header/);
  });

  it('does not echo the token while rejecting it', () => {
    expect(() => createGitHubClient({ token: `﻿${TOKEN}` })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(TOKEN) as unknown as string,
      }),
    );
  });
});

describe('conditional requests', () => {
  it('replays a stored ETag as If-None-Match', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      response({}, { status: 304 }),
    );
    await client(fetchImpl as unknown as typeof fetch).getJson('/repos/a/b', 'W/"abc"');

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('if-none-match')).toBe('W/"abc"');
  });

  it('treats 304 as unchanged and spends no budget', async () => {
    const api = client((async () => response({}, { status: 304 })) as unknown as typeof fetch);
    const result = await api.getJson('/repos/a/b', 'W/"abc"');

    expect(result).toEqual({ status: 'unchanged' });
    expect(api.stats().consumed).toBe(0);
    expect(api.stats().unchanged).toBe(1);
  });

  it('returns data and the new ETag on 200', async () => {
    const api = client(
      (async () => response({ forks_count: 7 }, { etag: 'W/"new"' })) as unknown as typeof fetch,
    );
    const result = await api.getJson<{ forks_count: number }>('/repos/a/b');

    expect(result).toEqual({ status: 'ok', data: { forks_count: 7 }, etag: 'W/"new"' });
    expect(api.stats().consumed).toBe(1);
  });
});

describe('failure handling', () => {
  it('reports 404 as missing rather than throwing', async () => {
    // Deleted, renamed, or gone private. The collector marks it inactive and
    // carries on; the watchlist is hand-curated and always drifts.
    const api = client((async () => response({}, { status: 404 })) as unknown as typeof fetch);
    expect(await api.getJson('/repos/a/b')).toEqual({ status: 'missing' });
  });

  it('never retries a 4xx', async () => {
    const fetchImpl = vi.fn(async () => response({}, { status: 422 }));
    await expect(client(fetchImpl as unknown as typeof fetch).getJson('/repos/a/b')).rejects.toThrow(
      /GitHub 422/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx three times and then gives up', async () => {
    const fetchImpl = vi.fn(async () => response({}, { status: 502 }));
    await expect(client(fetchImpl as unknown as typeof fetch).getJson('/repos/a/b')).rejects.toThrow(
      /gave up after 3 attempts/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('recovers when a retry succeeds', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? response({}, { status: 503 }) : response({ forks_count: 1 });
    });

    const result = await client(fetchImpl as unknown as typeof fetch).getJson('/repos/a/b');
    expect(result.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops the run on a secondary rate limit instead of backing off', async () => {
    // A secondary limit is a behavioural penalty that can restrict the token
    // beyond this run. Retrying makes it worse.
    const fetchImpl = vi.fn(async () =>
      response({ message: 'You have exceeded a secondary rate limit' }, {
        status: 403,
        retryAfter: '60',
      }),
    );
    await expect(client(fetchImpl as unknown as typeof fetch).getJson('/repos/a/b')).rejects.toThrow(
      SecondaryRateLimitError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('budget', () => {
  it('stops cleanly once remaining drops below the floor', async () => {
    const api = client(
      (async () => response({ forks_count: 1 }, { remaining: '499' })) as unknown as typeof fetch,
      { floor: 500 },
    );

    // The request that crosses the floor still returns; the next one refuses.
    expect((await api.getJson('/repos/a/b')).status).toBe('ok');
    expect(api.isExhausted()).toBe(true);
    await expect(api.getJson('/repos/c/d')).rejects.toThrow(BudgetExhaustedError);
  });

  it('keeps going while the budget is healthy', async () => {
    const api = client(
      (async () => response({ forks_count: 1 }, { remaining: '4000' })) as unknown as typeof fetch,
    );
    await api.getJson('/repos/a/b');
    expect(api.isExhausted()).toBe(false);
    expect(api.stats().rateLimitRemaining).toBe(4000);
  });

  it('never puts the token in an error message', async () => {
    const api = client((async () => response({}, { status: 418 })) as unknown as typeof fetch);
    await expect(api.getJson('/repos/a/b')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) as unknown as string }),
    );
  });
});
