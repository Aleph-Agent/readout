/**
 * Sign-in, as pure functions.
 *
 * Everything here is decided rather than fetched: what a cookie header means,
 * what a token hashes to, whether a session has run out, what URL GitHub should
 * be sent. The parts that talk to GitHub and to the database live in the Pages
 * Functions and do nothing but call into this file, so the rules can be tested
 * without a network, a browser or a deployment.
 *
 * That split is not tidiness. Auth bugs are silent — a session that never
 * expires, a state check that passes on an empty string, a cookie that is
 * readable from JavaScript — and none of them show up as a failed request. They
 * only show up as somebody being signed in as somebody else. So the rules are
 * written where a test can hold them still.
 *
 * Uses Web Crypto, which workerd and Node 24 both have. No dependencies.
 */

/** The signed-in session. Read on every request that touches an account. */
export const SESSION_COOKIE = 'st_session';

/** The CSRF nonce, alive only for the round trip to GitHub and back. */
export const STATE_COOKIE = 'st_oauth_state';

/** Thirty days. Long enough not to nag, short enough that a stolen cookie dies. */
export const SESSION_DAYS = 30;

/** Ten minutes. Nobody takes longer than that to approve an OAuth prompt. */
export const STATE_SECONDS = 600;

/**
 * GitHub, and nothing else.
 *
 * Google was considered and dropped. Every developer already has a GitHub
 * account, so a second provider buys no users, and it would introduce the rule
 * that decides whether two accounts with one email address are the same person
 * — the rule that, done wrong, lets whoever controls an email take over
 * somebody else's account.
 */
export const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER = 'https://api.github.com/user';

/**
 * No scopes. Deliberately, and worth saying out loud on the sign-in page.
 *
 * An empty scope still returns the numeric id and login from `/user`, which is
 * everything this product needs to know about somebody. Asking for `repo` would
 * be easier — it is the reflex — and it would mean holding a token that can read
 * every private repository of every customer. This holds a token that can read
 * a username, and it discards even that once the account row is written.
 */
export const GITHUB_SCOPE = '';

/**
 * A URL-safe random string.
 *
 * Session tokens and CSRF nonces both come from here. 32 bytes because the
 * value is guessed at, not derived from anything, and there is no rate limit on
 * a cookie somebody sets themselves.
 */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64url(buffer);
}

function base64url(buffer: Uint8Array): string {
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * What goes in the database where a token would.
 *
 * Plain SHA-256, not a password hash, and the difference matters. A password
 * needs a slow hash because it is short, chosen by a human and guessable. A
 * 32-byte random token is none of those, so the only property needed is that
 * the database cannot be read backwards into live sessions — and a fast hash
 * gives that, on every request, without spending a Worker's CPU budget.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Cookies, as sent by the browser.
 *
 * Tolerant of the shapes real headers arrive in — no space after the semicolon,
 * an empty value, a stray trailing one — because a parser that returns nothing
 * on a malformed header signs somebody out for a reason they cannot see.
 * Values are percent-decoded to match what `serializeCookie` wrote.
 */
export function parseCookies(header: string | null): Record<string, string> {
  const jar: Record<string, string> = {};
  if (header === null || header === '') return jar;

  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;

    const name = part.slice(0, at).trim();
    if (name === '') continue;

    const raw = part.slice(at + 1).trim();
    try {
      jar[name] = decodeURIComponent(raw);
    } catch {
      // A value that is not valid percent-encoding is somebody else's cookie,
      // not ours. Skip it rather than failing the whole header.
      jar[name] = raw;
    }
  }

  return jar;
}

export interface CookieOptions {
  /** Seconds. Zero clears the cookie. */
  maxAge: number;
  /**
   * Off only in tests. In production this is always true, and a cookie without
   * it travels in clear text the first time somebody types the domain without
   * a scheme.
   */
  secure?: boolean;
}

/**
 * A `Set-Cookie` value.
 *
 * `HttpOnly` always: a session token readable from JavaScript is a session
 * token that any injected script can take, and none of the rest of this matters
 * after that.
 *
 * `SameSite=Lax`, not `Strict`. Strict withholds the cookie on a top-level
 * navigation from another site — which is precisely what GitHub's redirect back
 * is — so the state cookie would be missing on arrival and every sign-in would
 * fail the CSRF check it was meant to pass. Lax sends it on that navigation and
 * still withholds it from cross-site form posts and subrequests.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.trunc(options.maxAge))}`,
  ];

  if (options.secure !== false) parts.push('Secure');
  if (options.maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');

  return parts.join('; ');
}

/** Clears a cookie. Same attributes as when it was set, or the browser keeps it. */
export function clearCookie(name: string, options: { secure?: boolean } = {}): string {
  return serializeCookie(name, '', {
    maxAge: 0,
    ...(options.secure === undefined ? {} : { secure: options.secure }),
  });
}

/**
 * Compares two secrets without leaking where they first differ.
 *
 * `===` on strings stops at the first mismatched byte, and the time it took is
 * observable. The exposure here is small — a CSRF nonce, not a password — but
 * the function is four lines and the alternative is remembering which
 * comparisons were safe.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return difference === 0;
}

/**
 * Is the state GitHub sent back the state we issued.
 *
 * Both empty is the case worth naming. Without the emptiness check the whole
 * CSRF defence would pass for anybody who sends no cookie and no state
 * parameter, which is the easiest request in the world to make.
 */
export function stateMatches(fromCookie: string | undefined, fromQuery: string | null): boolean {
  if (fromCookie === undefined || fromCookie === '') return false;
  if (fromQuery === null || fromQuery === '') return false;
  return timingSafeEqual(fromCookie, fromQuery);
}

/** Where to send somebody to approve the sign-in. */
export function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('scope', GITHUB_SCOPE);
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

/** The callback URL, derived from the request so it is right on every preview deployment. */
export function callbackUrl(requestUrl: string): string {
  return new URL('/api/auth/github/callback', requestUrl).toString();
}

/**
 * Where to land somebody after they sign in.
 *
 * Same-origin paths only. A `?next=` that accepts a full URL is an open
 * redirect: the sign-in link is on our domain, so a phishing page reached
 * through it inherits the trust of the domain that sent them. Protocol-relative
 * `//evil.example` is the case a naive `startsWith('/')` check waves through,
 * so it is rejected by name.
 */
export function safeNext(next: string | null, fallback = '/stack'): string {
  if (next === null || next === '') return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}

/** An ISO timestamp `seconds` from `now`, in the shape the ledger uses everywhere. */
export function isoIn(seconds: number, now: Date = new Date()): string {
  return new Date(now.getTime() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Has this session run out.
 *
 * Checked in the worker as well as being a column, because a row is only
 * deleted when something gets round to deleting it, and "the sweeper has not
 * run yet" must never mean "still signed in".
 */
export function isExpired(expiresAt: string, now: Date = new Date()): boolean {
  const at = Date.parse(expiresAt);
  // An unparseable timestamp is treated as expired. The alternative is a row
  // with a corrupt date being a session that never ends.
  if (!Number.isFinite(at)) return true;
  return at <= now.getTime();
}
