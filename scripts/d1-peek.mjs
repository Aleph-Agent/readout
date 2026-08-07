/**
 * What is actually in the database.
 *
 * Counts only. No login, no token hash, no invoice amount — nothing that
 * identifies a person ends up in a workflow log that anybody with read access
 * to this repository can page through. The questions worth asking here are
 * "did anything get written" and "how much", and both are answerable without
 * naming anybody.
 *
 * Written to answer one specific failure — somebody authorised on GitHub and
 * the site still showed them signed out — where the fault is either in the
 * callback that writes the row or in the browser that reads the cookie, and
 * those are two entirely different bugs. One row count splits them.
 *
 * Kept afterwards. "How many accounts are there" is a question this project
 * will have again, and the answer should not require writing this twice.
 */

const ACCOUNT = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '';
const TOKEN = process.env['CLOUDFLARE_API_TOKEN'] ?? '';
const DATABASE = process.env['D1_DATABASE'] ?? 'sighttrue';

const API = 'https://api.cloudflare.com/client/v4';

async function call(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });

  const body = await response.json();
  if (!body.success) {
    const errors = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`${path} → ${response.status} ${errors}`);
  }

  return body.result;
}

if (ACCOUNT === '' || TOKEN === '') {
  console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set.');
  process.exit(1);
}

const databases = await call(`/accounts/${ACCOUNT}/d1/database?per_page=100`);
const found = databases.find((entry) => entry.name === DATABASE);
if (!found) {
  console.error(`no database named ${DATABASE}`);
  process.exit(1);
}

async function query(sql) {
  const result = await call(`/accounts/${ACCOUNT}/d1/database/${found.uuid}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
  return result[0]?.results ?? [];
}

for (const table of [
  'accounts',
  'sessions',
  'watchlists',
  'watch_items',
  'invoices',
  'payments',
  'entitlements',
  'api_keys',
]) {
  const rows = await query(`SELECT count(*) AS n FROM ${table}`);
  console.log(`${table.padEnd(14)} ${rows[0]?.n ?? '?'}`);
}

// Ages rather than timestamps, for the same reason as the counts: a creation
// time plus a public commit log is enough to work out who somebody is.
const recent = await query(
  `SELECT round((julianday('now') - julianday(created_at)) * 1440) AS minutes_ago
     FROM accounts ORDER BY id DESC LIMIT 5`,
);
console.log(
  `most recent accounts, minutes ago: ${
    recent.length === 0 ? 'none' : recent.map((row) => row.minutes_ago).join(', ')
  }`,
);

const live = await query(
  `SELECT count(*) AS n FROM sessions WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
);
console.log(`sessions not yet expired: ${live[0]?.n ?? '?'}`);
