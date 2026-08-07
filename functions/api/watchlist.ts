/**
 * Somebody's own watchlist.
 *
 * Returns names and nothing else. The readings — advisories, scorecard, last
 * real ship date — come from `/data/stack-index.json`, which is a static file
 * already on the CDN, and the page joins the two. That is not an optimisation:
 * the site's rule is that no page depends on a running server for what it
 * asserts, and a watchlist page whose figures came out of a Worker would be the
 * first one that did. Here the Worker knows who you are; the files say what is
 * true.
 *
 * Every query is scoped by `account_id` from the session — never from anything
 * in the request. An id in a path or a body is a suggestion from whoever is
 * asking, and the entire difference between a private watchlist and a public
 * one is that this file never takes that suggestion.
 */

import { checkItem, checkRoom, planFrom } from '../../src/lib/watchlist-api.ts';
import { isoIn } from '../../src/lib/auth.ts';
import { json, unauthorized, viewerFrom, type Env, type Viewer } from './auth/_session.ts';

/**
 * The default list, made on first use.
 *
 * One list per account for now. The table allows several because splitting a
 * stack by service is the obvious next ask and a schema migration to add it
 * later is more expensive than a column that is always 1 today.
 */
async function listIdFor(env: Env, viewer: Viewer): Promise<number> {
  const existing = await env.DB.prepare(
    'SELECT id FROM watchlists WHERE account_id = ? ORDER BY id LIMIT 1',
  )
    .bind(viewer.accountId)
    .first<{ id: number }>();

  if (existing !== null) return existing.id;

  const created = await env.DB.prepare(
    `INSERT INTO watchlists (account_id, name, created_at) VALUES (?, 'My stack', ?) RETURNING id`,
  )
    .bind(viewer.accountId, isoIn(0))
    .first<{ id: number }>();

  // The insert either returns a row or throws; this satisfies the type and
  // would only be reached if D1 changed its RETURNING behaviour.
  if (created === null) throw new Error('could not create a watchlist');
  return created.id;
}

async function planFor(env: Env, viewer: Viewer): Promise<string> {
  const entitlement = await env.DB.prepare(
    'SELECT plan_id, valid_until FROM entitlements WHERE account_id = ?',
  )
    .bind(viewer.accountId)
    .first<{ plan_id: string; valid_until: string | null }>();

  return planFrom(entitlement);
}

export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const viewer = await viewerFrom(context.request, context.env);
  if (viewer === null) return unauthorized();

  const listId = await listIdFor(context.env, viewer);
  const rows = await context.env.DB.prepare(
    `SELECT registry, name, added_at
       FROM watch_items
      WHERE watchlist_id = ?
      ORDER BY registry, name`,
  )
    .bind(listId)
    .all<{ registry: string; name: string; added_at: string }>();

  const plan = await planFor(context.env, viewer);
  const room = checkRoom(plan, rows.results.length);

  return json({
    plan,
    // Sent every time so the page can show "6 of 10" without knowing the plan
    // table. One place decides the limits.
    limit: room.ok ? room.limit : rows.results.length,
    items: rows.results.map((row) => ({
      registry: row.registry,
      name: row.name,
      addedAt: row.added_at,
    })),
  });
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const viewer = await viewerFrom(context.request, context.env);
  if (viewer === null) return unauthorized();

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'send JSON' }, 400);
  }

  const item = checkItem(body as { registry?: unknown; name?: unknown });
  if (!item.ok) return json({ error: item.error }, item.status);

  const listId = await listIdFor(context.env, viewer);

  const counted = await context.env.DB.prepare(
    'SELECT count(*) AS n FROM watch_items WHERE watchlist_id = ?',
  )
    .bind(listId)
    .first<{ n: number }>();

  const room = checkRoom(await planFor(context.env, viewer), counted?.n ?? 0);
  if (!room.ok) return json({ error: room.error }, room.status);

  // `ON CONFLICT DO NOTHING` against the unique index, so adding the same
  // package twice is the same as adding it once rather than an error somebody
  // has to handle. Idempotent by construction: an agent retrying a request it
  // is not sure landed gets the same result both times.
  await context.env.DB.prepare(
    `INSERT INTO watch_items (watchlist_id, registry, name, added_at)
          VALUES (?, ?, ?, ?)
     ON CONFLICT (watchlist_id, registry, name) DO NOTHING`,
  )
    .bind(listId, item.registry, item.name, isoIn(0))
    .run();

  return json({ watching: { registry: item.registry, name: item.name } }, 201);
}

export async function onRequestDelete(context: { request: Request; env: Env }): Promise<Response> {
  const viewer = await viewerFrom(context.request, context.env);
  if (viewer === null) return unauthorized();

  const url = new URL(context.request.url);
  const item = checkItem({
    registry: url.searchParams.get('registry'),
    name: url.searchParams.get('name'),
  });
  if (!item.ok) return json({ error: item.error }, item.status);

  // The join to `watchlists` is what makes the account check part of the query
  // rather than a separate read that somebody could later forget to write.
  const result = await context.env.DB.prepare(
    `DELETE FROM watch_items
      WHERE registry = ? AND name = ?
        AND watchlist_id IN (SELECT id FROM watchlists WHERE account_id = ?)`,
  )
    .bind(item.registry, item.name, viewer.accountId)
    .run();

  // Removing something that is not there is a success. The end state is what
  // was asked for, and a 404 here makes a double-click look like a failure.
  return json({ removed: result.meta.changes > 0 });
}
