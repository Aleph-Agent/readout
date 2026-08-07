/**
 * Does a real session cookie sign somebody in.
 *
 * The half of sign-in that cannot be tested from a laptop and cannot be tested
 * offline: mint a session the way the callback does, hand it to the live
 * endpoint as a cookie, and see whether the account comes back.
 *
 * It exists because the row counts said the callback works — one account, eight
 * live sessions — while the site kept showing the person signed out. That
 * narrows the fault to the read path or the browser, and this tells the two
 * apart: if the endpoint returns the account here, the server is right and the
 * problem is in front of it.
 *
 * The token is generated here, used once, and the row is deleted at the end. It
 * is never printed. A workflow log is readable by anybody with access to the
 * repository, and a session token in one is a session token.
 */

const ACCOUNT = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '';
const TOKEN = process.env['CLOUDFLARE_API_TOKEN'] ?? '';
const DATABASE = process.env['D1_DATABASE'] ?? 'sighttrue';
const SITE = process.env['SITE'] ?? 'https://sighttrue.com';

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
const database = databases.find((entry) => entry.name === DATABASE);
if (!database) {
  console.error(`no database named ${DATABASE}`);
  process.exit(1);
}

const query = async (sql, params = []) =>
  (
    await call(`/accounts/${ACCOUNT}/d1/database/${database.uuid}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, params }),
    })
  )[0]?.results ?? [];

// The same shapes as src/lib/auth.ts. Rewritten rather than imported because
// that file is TypeScript compiled for two other runtimes; if these two ever
// disagree, this smoke test fails, which is the alarm working.
function randomToken() {
  const buffer = new Uint8Array(32);
  crypto.getRandomValues(buffer);
  return Buffer.from(buffer).toString('base64url');
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const accounts = await query('SELECT id FROM accounts ORDER BY id DESC LIMIT 1');
if (accounts.length === 0) {
  console.error('no accounts yet — sign in once first');
  process.exit(1);
}

const accountId = accounts[0].id;
const token = randomToken();
const hash = await hashToken(token);
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const soon = new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

await query(
  'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  [hash, accountId, now, soon],
);
console.log(`minted a ten-minute session for account ${accountId}`);

let failed = false;
try {
  const response = await fetch(`${SITE}/api/auth/me`, {
    headers: { cookie: `st_session=${token}` },
  });
  const body = await response.text();
  console.log(`me → ${response.status} ${body.replace(/\s+/g, ' ')}`);

  if (!body.includes('"login"')) {
    console.error('the endpoint did not recognise a valid session — the read path is broken');
    failed = true;
  } else {
    console.log('the read path works: a real cookie signs somebody in');
  }

  // The watchlist too, since it is the thing behind the sign-in.
  const list = await fetch(`${SITE}/api/watchlist`, {
    headers: { cookie: `st_session=${token}` },
  });
  console.log(`watchlist → ${list.status} ${(await list.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
  if (!list.ok) failed = true;
} finally {
  // Always, including after a failure. A test that leaves a live session behind
  // when it breaks is a test that leaks credentials on its worst day.
  await query('DELETE FROM sessions WHERE token_hash = ?', [hash]);
  console.log('session deleted');
}

if (failed) process.exit(1);
