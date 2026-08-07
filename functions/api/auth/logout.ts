/**
 * Sign out.
 *
 * POST, not GET. A GET that destroys a session can be triggered by an image tag
 * on any other site, which is a nuisance rather than a breach, but it is a
 * nuisance that costs one line to prevent.
 *
 * The row goes, not just the cookie. Clearing the cookie alone leaves a live
 * session in the database for thirty days — so anybody who copied the token
 * before the user signed out still has it, and the user believes otherwise.
 */

import { clearCookie, hashToken, parseCookies, SESSION_COOKIE } from '../../../src/lib/auth.ts';
import { JSON_HEADERS, type Env } from './_session.ts';

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];

  if (token !== undefined && token !== '') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await hashToken(token))
      .run();
  }

  const headers = new Headers(JSON_HEADERS);
  headers.append(
    'set-cookie',
    clearCookie(SESSION_COOKIE, { secure: new URL(request.url).protocol === 'https:' }),
  );

  // Signing out when already signed out is a success. Anything else means a
  // stale tab shows an error for doing the right thing.
  return new Response(JSON.stringify({ signedOut: true }), { status: 200, headers });
}
