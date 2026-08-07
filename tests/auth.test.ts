import { describe, expect, it } from 'vitest';

import {
  authorizeUrl,
  callbackUrl,
  clearCookie,
  GITHUB_SCOPE,
  hashToken,
  isExpired,
  isoIn,
  parseCookies,
  randomToken,
  safeNext,
  serializeCookie,
  SESSION_COOKIE,
  stateMatches,
  timingSafeEqual,
} from '../src/lib/auth.ts';

/**
 * Auth failures are silent. A session that never expires, a state check that
 * passes on an empty string, a cookie readable from JavaScript — none of them
 * produce a failed request, an error page or a log line. They produce somebody
 * signed in as somebody else, and nobody finds out.
 *
 * So each test below is one way this could be wrong without looking wrong.
 */

describe('tokens', () => {
  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => randomToken()));
    expect(seen.size).toBe(500);
  });

  it('survives a cookie, a URL and a query string unaltered', () => {
    // Base64url rather than base64. `+` becomes a space when a value is
    // form-decoded and `/` ends a cookie path, so a token containing either can
    // come back different from how it went out — intermittently, depending on
    // which bytes the generator happened to produce.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('hashes to something that does not contain the token', async () => {
    const token = randomToken();
    const hash = await hashToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('hashes the same token to the same row, always', async () => {
    // The lookup on every authenticated request. If this were not stable the
    // symptom would be random sign-outs, which read as a flaky browser.
    const token = randomToken();
    expect(await hashToken(token)).toBe(await hashToken(token));
  });

  it('gives two tokens two different hashes', async () => {
    expect(await hashToken('a')).not.toBe(await hashToken('b'));
  });
});

describe('cookies', () => {
  it('reads a header the way browsers actually send it', () => {
    const jar = parseCookies('a=1;b=2; c=3 ;  d=4;');

    expect(jar).toEqual({ a: '1', b: '2', c: '3', d: '4' });
  });

  it('returns nothing for no header rather than throwing', () => {
    // A signed-out visitor sends no cookie header at all. This path runs on
    // every anonymous request the site serves.
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('ignores a malformed pair instead of losing the rest of the header', () => {
    // Analytics and consent tools write cookies this project never sees the
    // shape of. One of them being odd must not sign anybody out.
    expect(parseCookies('broken; =nameless; st_session=abc')).toEqual({ st_session: 'abc' });
  });

  it('round-trips a value that needs encoding', () => {
    const header = serializeCookie('x', 'a b;c=d', { maxAge: 60 });
    const value = header.slice('x='.length, header.indexOf(';'));

    expect(parseCookies(`x=${value}`)).toEqual({ x: 'a b;c=d' });
  });

  it('is unreadable from JavaScript, and never leaves in clear text', () => {
    const header = serializeCookie(SESSION_COOKIE, 'token', { maxAge: 60 });

    // The whole session scheme rests on these two. HttpOnly is what stops an
    // injected script reading the token; Secure is what stops it travelling in
    // clear the first time somebody types the domain without a scheme.
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
  });

  it('uses Lax, because Strict would break every sign-in', () => {
    // Strict withholds the cookie on a top-level navigation from another site,
    // which is exactly what GitHub's redirect back is. The state cookie would
    // be missing on arrival and the CSRF check would fail the flow it exists to
    // protect — a bug that only appears in a real browser, never in a test that
    // calls the handler directly.
    expect(serializeCookie('x', 'y', { maxAge: 60 })).toContain('SameSite=Lax');
  });

  it('clears with the same attributes it set', () => {
    // A browser matches a clearing cookie on name, path and domain. Different
    // attributes leave the original in place and sign-out silently does nothing.
    const cleared = clearCookie(SESSION_COOKIE);

    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
  });

  it('never emits a negative Max-Age', () => {
    expect(serializeCookie('x', 'y', { maxAge: -99 })).toContain('Max-Age=0');
  });
});

describe('the state check', () => {
  it('accepts the nonce it issued', () => {
    const state = randomToken();
    expect(stateMatches(state, state)).toBe(true);
  });

  it('rejects a mismatch', () => {
    expect(stateMatches(randomToken(), randomToken())).toBe(false);
  });

  it('rejects the empty request that would otherwise pass', () => {
    // The case the whole defence turns on. Without an emptiness check, a
    // comparison of two empty strings succeeds — so sending no cookie and no
    // state parameter would satisfy the CSRF check, and that is the easiest
    // request in the world to make.
    expect(stateMatches('', '')).toBe(false);
    expect(stateMatches(undefined, '')).toBe(false);
    expect(stateMatches(undefined, null)).toBe(false);
    expect(stateMatches('issued', null)).toBe(false);
    expect(stateMatches('', 'sent')).toBe(false);
  });

  it('compares without revealing where two secrets diverge', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('the GitHub redirect', () => {
  const url = authorizeUrl({
    clientId: 'Ov23li_example',
    redirectUri: 'https://sighttrue.com/api/auth/github/callback',
    state: 'nonce',
  });

  it('asks for no scopes at all', () => {
    // Worth a test rather than a comment. Asking for `repo` is the reflex, and
    // it would mean this deployment holds a token that can read every private
    // repository of every customer. An empty scope still returns the id and
    // login, which is all this product knows about anybody.
    expect(GITHUB_SCOPE).toBe('');
    expect(new URL(url).searchParams.get('scope')).toBe('');
  });

  it('carries the nonce and the exact callback', () => {
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(parsed.searchParams.get('state')).toBe('nonce');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://sighttrue.com/api/auth/github/callback',
    );
  });

  it('derives the callback from the request, so previews work', () => {
    // Hardcoding the production callback would send everybody testing a preview
    // deployment to production, where their state cookie does not exist.
    expect(callbackUrl('https://abc123.sighttrue-site.pages.dev/api/auth/github/start')).toBe(
      'https://abc123.sighttrue-site.pages.dev/api/auth/github/callback',
    );
  });
});

describe('where somebody lands afterwards', () => {
  it('keeps a same-origin path', () => {
    expect(safeNext('/watch')).toBe('/watch');
    expect(safeNext('/stack?q=react')).toBe('/stack?q=react');
  });

  it('refuses to become an open redirect', () => {
    // The sign-in link is on this domain, so a phishing page reached through it
    // inherits the trust of the domain that sent them there.
    expect(safeNext('https://evil.example')).toBe('/stack');
    expect(safeNext('http://evil.example')).toBe('/stack');
  });

  it('refuses the protocol-relative form a naive check waves through', () => {
    // `//evil.example` starts with a slash and is a fully qualified URL. Any
    // check that is only `startsWith('/')` accepts it.
    expect(safeNext('//evil.example')).toBe('/stack');
    expect(safeNext('/\\evil.example')).toBe('/stack');
  });

  it('falls back when nothing was asked for', () => {
    expect(safeNext(null)).toBe('/stack');
    expect(safeNext('')).toBe('/stack');
  });
});

describe('expiry', () => {
  const now = new Date('2026-08-07T12:00:00Z');

  it('is checked in the worker, not left to the sweeper', () => {
    // A row is only deleted when something gets round to deleting it, and "the
    // cleanup job has not run yet" must never mean "still signed in".
    expect(isExpired('2026-08-07T11:59:59Z', now)).toBe(true);
    expect(isExpired('2026-08-07T12:00:01Z', now)).toBe(false);
  });

  it('treats the exact boundary as over', () => {
    expect(isExpired('2026-08-07T12:00:00Z', now)).toBe(true);
  });

  it('treats an unreadable timestamp as expired', () => {
    // The alternative is that a corrupt date is a session that never ends.
    expect(isExpired('', now)).toBe(true);
    expect(isExpired('not a date', now)).toBe(true);
  });

  it('writes timestamps in the shape the rest of the ledger uses', () => {
    expect(isoIn(60, now)).toBe('2026-08-07T12:01:00Z');
    expect(isoIn(0, now)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
