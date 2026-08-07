/**
 * Back from GitHub, with a code.
 *
 * The order below is the security-relevant part and it is deliberate: refuse
 * anything wrong before spending a network call, and never let a failure leave
 * a half-made session behind.
 *
 *   1. Did GitHub itself refuse. Report that, do not carry on.
 *   2. Does the state match the cookie. Everything after this assumes the
 *      browser that arrived is the browser that started.
 *   3. Burn the state cookie, whatever happens next. A nonce that survives its
 *      one use is not a nonce.
 *   4. Exchange the code for a token, and use the token once, to ask who this
 *      is. Nothing keeps it afterwards.
 *   5. Write the account, mint the session, redirect.
 *
 * The access token is never stored. It is requested with no scopes, used for a
 * single call to `/user`, and dropped when this function returns — so a leak of
 * this database is a leak of numeric ids and usernames, not of anybody's access
 * to their own repositories.
 */

import {
  GITHUB_TOKEN,
  GITHUB_USER,
  callbackUrl,
  clearCookie,
  hashToken,
  isoIn,
  parseCookies,
  randomToken,
  safeNext,
  serializeCookie,
  SESSION_COOKIE,
  SESSION_DAYS,
  STATE_COOKIE,
  stateMatches,
} from '../../../../src/lib/auth.ts';
import type { Env } from '../_session.ts';

const NEXT_COOKIE = 'st_oauth_next';

function fail(reason: string, status: number, secure: boolean): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  // Cleared on every failure path. A state cookie left behind after a rejected
  // callback is a nonce an attacker already knows the shape of.
  headers.append('set-cookie', clearCookie(STATE_COOKIE, { secure }));
  headers.append('set-cookie', clearCookie(NEXT_COOKIE, { secure }));

  return new Response(JSON.stringify({ error: reason }), { status, headers });
}

export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';

  const clientId = env.OAUTH_GITHUB_CLIENT_ID;
  const clientSecret = env.OAUTH_GITHUB_SECRET;
  if (!clientId || !clientSecret) {
    return fail('sign-in is not configured on this deployment', 503, secure);
  }

  // GitHub says no before we do. Somebody clicking Cancel is not an error worth
  // a stack trace, but it is not a success either.
  const denied = url.searchParams.get('error');
  if (denied !== null) {
    return fail(`GitHub refused the sign-in: ${denied}`, 400, secure);
  }

  const cookies = parseCookies(request.headers.get('cookie'));
  if (!stateMatches(cookies[STATE_COOKIE], url.searchParams.get('state'))) {
    // The check that stops somebody handing a victim a pre-baked callback link
    // and signing that victim's browser into the attacker's account.
    return fail('this sign-in did not start here', 400, secure);
  }

  const code = url.searchParams.get('code');
  if (code === null || code === '') return fail('no code in the callback', 400, secure);

  // ---- exchange the code -------------------------------------------------

  let accessToken: string;
  try {
    const response = await fetch(GITHUB_TOKEN, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        // Sent again on purpose. GitHub checks it against the one used at the
        // authorize step, which is what stops a code issued for this site being
        // redeemed by a different one.
        redirect_uri: callbackUrl(request.url),
      }),
    });

    const body = (await response.json()) as { access_token?: string; error_description?: string };
    // The failure arrives as HTTP 200 with an error in the body, so checking
    // `response.ok` alone would treat a refusal as a token.
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      return fail(body.error_description ?? 'GitHub did not return a token', 400, secure);
    }
    accessToken = body.access_token;
  } catch {
    // Never quotes the exception. An error from a call carrying a client secret
    // is the last place that secret should be allowed to surface.
    return fail('could not reach GitHub to complete the sign-in', 502, secure);
  }

  // ---- ask who this is ---------------------------------------------------

  let providerId: string;
  let login: string;
  try {
    const response = await fetch(GITHUB_USER, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        // GitHub rejects an API request with no user agent.
        'user-agent': 'sighttrue',
      },
    });
    if (!response.ok) return fail('GitHub would not say who this is', 502, secure);

    const user = (await response.json()) as { id?: number; login?: string };
    if (typeof user.id !== 'number' || typeof user.login !== 'string') {
      return fail('GitHub returned an account without an id', 502, secure);
    }

    // The numeric id is the identity. The login is display only — it gets
    // renamed and then reused by somebody else, and keying on it would hand one
    // person another person's account along with everything they paid for.
    providerId = String(user.id);
    login = user.login;
  } catch {
    return fail('could not reach GitHub to complete the sign-in', 502, secure);
  }

  // ---- write the account and the session ---------------------------------

  const now = isoIn(0);

  const account = await env.DB.prepare(
    `INSERT INTO accounts (provider, provider_id, login, created_at)
          VALUES ('github', ?, ?, ?)
     ON CONFLICT (provider, provider_id)
       DO UPDATE SET login = excluded.login
       RETURNING id`,
  )
    .bind(providerId, login, now)
    .first<{ id: number }>();

  if (account === null) return fail('could not record the account', 500, secure);

  // Minted here, hashed before it is stored, and returned to the browser
  // exactly once. The database never holds a value that could be replayed as a
  // session.
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, account_id, created_at, expires_at)
          VALUES (?, ?, ?, ?)`,
  )
    .bind(await hashToken(token), account.id, now, isoIn(SESSION_DAYS * 86_400))
    .run();

  const headers = new Headers({
    location: safeNext(cookies[NEXT_COOKIE] ?? null),
    'cache-control': 'no-store',
  });
  headers.append(
    'set-cookie',
    serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86_400, secure }),
  );
  headers.append('set-cookie', clearCookie(STATE_COOKIE, { secure }));
  headers.append('set-cookie', clearCookie(NEXT_COOKIE, { secure }));

  return new Response(null, { status: 302, headers });
}
