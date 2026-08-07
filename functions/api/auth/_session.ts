/**
 * Who is asking.
 *
 * Every endpoint that touches an account starts here, and the underscore keeps
 * Pages from routing it — this is a helper, not a URL.
 *
 * The rules it applies are in `src/lib/auth.ts` and tested there. What is left
 * in this file is the part that needs a database: turn a cookie into a row, or
 * into nothing.
 */

import { isExpired, parseCookies, hashToken, SESSION_COOKIE } from '../../../src/lib/auth.ts';

export interface Env {
  DB: D1Database;
  OAUTH_GITHUB_CLIENT_ID?: string;
  OAUTH_GITHUB_SECRET?: string;
}

export interface Viewer {
  accountId: number;
  login: string;
}

export const JSON_HEADERS = {
  'content-type': 'application/json',
  // No shared cache may ever hold a response about a specific person.
  'cache-control': 'no-store',
};

/**
 * The signed-in account, or null.
 *
 * Expiry is checked here as well as being a column, because a row only
 * disappears when something gets round to deleting it and "the sweeper has not
 * run" must never mean "still signed in". An expired row is deleted on the way
 * past, so the table stays honest without a scheduled job for it.
 */
export async function viewerFrom(request: Request, env: Env): Promise<Viewer | null> {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (token === undefined || token === '') return null;

  const hash = await hashToken(token);

  const row = await env.DB.prepare(
    `SELECT sessions.expires_at AS expires_at,
            accounts.id        AS account_id,
            accounts.login     AS login
       FROM sessions
       JOIN accounts ON accounts.id = sessions.account_id
      WHERE sessions.token_hash = ?`,
  )
    .bind(hash)
    .first<{ expires_at: string; account_id: number; login: string }>();

  if (row === null) return null;

  if (isExpired(row.expires_at)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }

  return { accountId: row.account_id, login: row.login };
}

/** The one shape every endpoint here uses to say no. */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'sign in first' }), {
    status: 401,
    headers: JSON_HEADERS,
  });
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}
