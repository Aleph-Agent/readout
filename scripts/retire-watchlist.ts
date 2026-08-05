/**
 * Retire watchlist entries that GitHub reports as archived or gone.
 *
 *   node scripts/retire-watchlist.ts --dry-run
 *   node scripts/retire-watchlist.ts
 *
 * Marks them inactive rather than deleting them. The schema says why: removing
 * an entry would erase the record that it was ever watched, and the events
 * collected while it was are permanent and still link to it.
 *
 * An archived repository can still be forked, so one lens keeps working — but
 * it will never release again and never resolve an issue, so three of the five
 * are dead for it. That is not worth a request every four hours.
 *
 * Retiring is reversible: flip active back to true and the collector resumes.
 */

import { createGitHubClient } from '../src/lib/github.ts';
import { readWatchlist, writeWatchlist } from '../src/lib/ledger.ts';

interface RepoState {
  archived: boolean;
  full_name: string;
}

const token = process.env['GITHUB_PAT'] ?? '';
if (token === '') {
  console.error('GITHUB_PAT is not set.');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const client = createGitHubClient({ token });
const entries = readWatchlist();

const retiring: { id: string; reason: string }[] = [];

for (const entry of entries) {
  if (!entry.active) continue;

  const result = await client.getJson<RepoState>(`/repos/${entry.id}`);

  if (result.status === 'missing') {
    retiring.push({ id: entry.id, reason: 'gone' });
    continue;
  }
  if (result.status !== 'ok') continue;
  if (result.data.archived) retiring.push({ id: entry.id, reason: 'archived' });
}

console.log(`active entries : ${entries.filter((e) => e.active).length}`);
console.log(`to retire      : ${retiring.length}`);
console.log('');
for (const item of retiring) console.log(`  ${item.id.padEnd(46)} ${item.reason}`);

if (retiring.length === 0) {
  console.log('\nNothing to do.');
} else if (dryRun) {
  console.log('\nDry run, nothing written.');
} else {
  const retired = new Set(retiring.map((item) => item.id));
  writeWatchlist(entries.map((e) => (retired.has(e.id) ? { ...e, active: false } : e)));
  console.log(`\nMarked ${retiring.length} inactive. They stay on the list and stay linkable.`);
}
