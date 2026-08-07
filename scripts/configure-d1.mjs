/**
 * Create the database, apply the schema, bind it to the Pages project.
 *
 * Against the REST API rather than through `wrangler d1`. Wrangler's D1
 * commands do their own account lookup, and when that lookup fails they report
 * "Failed to automatically retrieve account IDs" — which describes wrangler's
 * fallback path, not the thing that actually went wrong. Two screens of that
 * output say nothing about whether the token can reach D1.
 *
 * So every call here is explicit, and every failure prints the API's own error
 * with its code. If this cannot work, the reason should be one line.
 *
 * Idempotent throughout. It runs on every configure, and a setup script that
 * can only be run once is a setup script nobody dares run.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ACCOUNT = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '';
const TOKEN = process.env['CLOUDFLARE_API_TOKEN'] ?? '';
const PROJECT = process.env['PAGES_PROJECT'] ?? 'readout';
const DATABASE = process.env['D1_DATABASE'] ?? 'sighttrue';

const API = 'https://api.cloudflare.com/client/v4';

if (ACCOUNT === '' || TOKEN === '') {
  console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set.');
  process.exit(1);
}

/**
 * One call, with the API's own words on failure.
 *
 * Cloudflare answers 200 with `success: false` often enough that checking the
 * status code alone is how a failed configure looks like a clean one.
 */
async function call(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status}, and not JSON`);
  }

  if (!body.success) {
    const errors = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${errors}`);
  }

  return body.result;
}

/** What this token is allowed to do, asked before anything is attempted. */
async function reportToken() {
  try {
    const verified = await call('/user/tokens/verify');
    console.log(`token status: ${verified.status}`);
  } catch (error) {
    // Not fatal on its own — a token scoped to one account cannot always read
    // its own definition — so it is reported and the run continues to the call
    // that actually matters.
    console.log(`token could not describe itself (${error.message})`);
  }
}

async function findDatabase() {
  const list = await call(`/accounts/${ACCOUNT}/d1/database?per_page=100`);
  return list.find((entry) => entry.name === DATABASE) ?? null;
}

async function ensureDatabase() {
  const existing = await findDatabase();
  if (existing !== null) {
    console.log(`database ${DATABASE} already exists (${existing.uuid})`);
    return existing.uuid;
  }

  const created = await call(`/accounts/${ACCOUNT}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name: DATABASE }),
  });
  console.log(`created ${DATABASE} (${created.uuid})`);
  return created.uuid;
}

/**
 * The schema, one statement at a time.
 *
 * Sent individually rather than as one blob so a failure names the statement
 * that failed. A migration that reports "syntax error" without saying where is
 * a migration somebody debugs by bisecting a file.
 *
 * PRAGMA lines are dropped. D1 manages its own connection pragmas and rejects
 * them over the query API; the one in the file is there for the SQLite the
 * tests run against, where it is honoured.
 */
function statements() {
  const sql = readFileSync(
    fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)),
    'utf8',
  );

  return sql
    .split(';')
    .map((part) =>
      part
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((part) => part !== '' && !/^PRAGMA/i.test(part));
}

async function applySchema(uuid) {
  const parts = statements();
  for (const [index, sql] of parts.entries()) {
    try {
      await call(`/accounts/${ACCOUNT}/d1/database/${uuid}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql }),
      });
    } catch (error) {
      console.error(`statement ${index + 1} failed: ${sql.split('\n')[0]}`);
      throw error;
    }
  }
  console.log(`applied ${parts.length} statements`);
}

/**
 * Bind it, without dropping what is already bound.
 *
 * Read, merge, write. The same object holds the environment variables the
 * secrets steps just set, and a blind PATCH with a fresh config would remove
 * them — silently, and the symptom would be an endpoint reporting itself
 * unconfigured hours later.
 */
async function bind(uuid) {
  const project = await call(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}`);
  const configs = project.deployment_configs ?? {};

  const merged = {};
  for (const environment of ['production', 'preview']) {
    merged[environment] = {
      ...(configs[environment] ?? {}),
      d1_databases: {
        ...(configs[environment]?.d1_databases ?? {}),
        DB: { id: uuid },
      },
    };
  }

  const updated = await call(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}`, {
    method: 'PATCH',
    body: JSON.stringify({ deployment_configs: merged }),
  });

  // Checks the answer, not the status. A 200 carrying an unchanged config is
  // the failure worth catching.
  const bound = updated.deployment_configs?.production?.d1_databases?.DB;
  if (!bound) throw new Error('the binding did not take');

  console.log(`bound DB → ${bound.id} on production and preview`);
}

/** Proves the schema is really there, by asking the database rather than the API. */
async function confirm(uuid) {
  const result = await call(`/accounts/${ACCOUNT}/d1/database/${uuid}/query`, {
    method: 'POST',
    body: JSON.stringify({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    }),
  });

  const tables = (result[0]?.results ?? []).map((row) => row.name).filter((n) => n !== undefined);
  console.log(`tables: ${tables.join(', ')}`);

  for (const wanted of ['accounts', 'sessions', 'watchlists', 'watch_items', 'invoices']) {
    if (!tables.includes(wanted)) throw new Error(`table ${wanted} is missing`);
  }
}

await reportToken();
const uuid = await ensureDatabase();
await applySchema(uuid);
await confirm(uuid);
await bind(uuid);
