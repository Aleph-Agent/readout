/**
 * Send somebody to GitHub to approve the sign-in.
 *
 * Two things happen and they have to happen together: a nonce goes into a
 * short-lived cookie, and the same nonce goes into the URL. On the way back the
 * callback checks they match. Without that, anybody can hand a victim a
 * pre-baked callback link and have the victim's browser complete a sign-in as
 * the attacker's account — after which everything the victim saves goes into a
 * watchlist somebody else can read.
 *
 * The nonce lives ten minutes. Nobody takes longer than that to click Authorize,
 * and a state cookie that outlives the tab is a state cookie somebody can reuse.
 */

import {
  authorizeUrl,
  callbackUrl,
  randomToken,
  safeNext,
  serializeCookie,
  STATE_COOKIE,
  STATE_SECONDS,
} from '../../../../src/lib/auth.ts';
import type { Env } from '../_session.ts';

/** Where the browser goes after the round trip, remembered across it. */
const NEXT_COOKIE = 'st_oauth_next';

export async function onRequestGet(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;
  const clientId = env.OAUTH_GITHUB_CLIENT_ID;

  if (clientId === undefined || clientId === '') {
    // Says what is wrong rather than redirecting to a GitHub page that reads
    // "The redirect_uri is not associated with this application", which sends
    // whoever is debugging it to the wrong system entirely.
    return new Response(
      JSON.stringify({
        error: 'sign-in is not configured on this deployment',
        detail: 'OAUTH_GITHUB_CLIENT_ID is not set',
      }),
      { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  }

  const state = randomToken();
  const next = safeNext(new URL(request.url).searchParams.get('next'));

  // Derived from the request, not hardcoded, so a preview deployment sends its
  // own origin. A hardcoded production callback would drop everybody testing a
  // preview onto production, where their state cookie does not exist.
  const redirectUri = callbackUrl(request.url);
  const secure = new URL(request.url).protocol === 'https:';

  const headers = new Headers({
    location: authorizeUrl({ clientId, redirectUri, state }),
    'cache-control': 'no-store',
  });

  headers.append(
    'set-cookie',
    serializeCookie(STATE_COOKIE, state, { maxAge: STATE_SECONDS, secure }),
  );
  headers.append(
    'set-cookie',
    serializeCookie(NEXT_COOKIE, next, { maxAge: STATE_SECONDS, secure }),
  );

  return new Response(null, { status: 302, headers });
}
