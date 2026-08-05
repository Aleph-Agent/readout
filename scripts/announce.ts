/**
 * Announce confirmed findings on X.
 *
 *   node scripts/announce.ts
 *   node scripts/announce.ts --limit=1
 *
 * Records every outcome before exiting, for the same reason the summariser
 * does: the workflow runs this with continue-on-error so a dead API never stops
 * measurement from publishing, which makes silent failure the default unless
 * the script writes down what happened.
 */

import { runAnnounce } from '../src/jobs/announce.ts';
import { readMeta, writeMeta } from '../src/lib/ledger.ts';

function numericFlag(name: string): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw.slice(name.length + 3), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} expects a positive integer`);
  return value;
}

function recordFailure(message: string): never {
  const previous = readMeta();
  writeMeta({
    ...previous,
    partial: true,
    collectorsErrored: [...previous.collectorsErrored, `announce: ${message}`],
  });
  console.error(`announce failed: ${message}`);
  console.error('Recorded in meta.json. Findings still publish on the site.');
  process.exit(1);
}

const required = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
const missing = required.filter((name) => (process.env[name] ?? '') === '');
if (missing.length > 0) recordFailure(`missing credentials: ${missing.join(', ')}`);

const limit = numericFlag('limit');

let result;
try {
  result = await runAnnounce(limit === undefined ? {} : { limit });
} catch (error) {
  recordFailure(error instanceof Error ? error.message : String(error));
}

console.log(
  [
    `eligible unposted : ${result.eligible}`,
    `posted            : ${result.posted}`,
    `skipped           : ${result.skipped}`,
  ].join('\n'),
);

for (const error of result.failed) console.warn(`warn: ${error}`);
