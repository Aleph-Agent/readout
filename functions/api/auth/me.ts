/**
 * Who am I, and what have I got.
 *
 * The one call the signed-in pages make on load. Signed out is a 200 with
 * `account: null`, not a 401 — an anonymous visitor is a normal state of this
 * site, not a failure, and a page that has to catch an error to render its
 * signed-out header will eventually render it wrong.
 */

import { json, viewerFrom, type Env } from './_session.ts';

export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const viewer = await viewerFrom(context.request, context.env);
  if (viewer === null) return json({ account: null, entitlement: null });

  const entitlement = await context.env.DB.prepare(
    `SELECT plan_id, valid_until, calls_remaining
       FROM entitlements
      WHERE account_id = ?`,
  )
    .bind(viewer.accountId)
    .first<{ plan_id: string; valid_until: string | null; calls_remaining: number | null }>();

  return json({
    account: { login: viewer.login },
    // Null means the free plan, not an error. Distinguishing "no row" from
    // "expired" is the caller's job and both mean the same thing here.
    entitlement:
      entitlement === null
        ? null
        : {
            plan: entitlement.plan_id,
            validUntil: entitlement.valid_until,
            callsRemaining: entitlement.calls_remaining,
          },
  });
}
