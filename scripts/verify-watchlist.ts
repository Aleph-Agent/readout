/**
 * Check every watchlist entry against what GitHub says about it.
 *
 *   node scripts/verify-watchlist.ts
 *
 * The watchlist is curated and that is deliberate — it is an editorial claim
 * about what is worth watching, and the project says so in public. Deriving it
 * mechanically was tried and produced a worse list: topic search only finds
 * repositories that tagged themselves, and sorting by stars selects tutorials
 * and link collections over infrastructure. See scripts/derive-watchlist.ts,
 * which is kept for proposing candidates a curator might have missed.
 *
 * What curation was missing is not a mechanism. It is verification. This is
 * that: every entry checked against the API, and every entry that no longer
 * meets the stated criteria named out loud.
 */

import { createGitHubClient, type RepoPayload } from '../src/lib/github.ts';
import { readWatchlist } from '../src/lib/ledger.ts';

/** Stated criteria. An entry failing one of these is reported, never removed. */
const CRITERIA = {
  /** Below this, activity is too sparse for a baseline to mean anything. */
  minStars: 500,
  /** Silent for longer than this and there is nothing left to measure. */
  maxQuietDays: 365,
};

interface FullRepo extends RepoPayload {
  archived: boolean;
  fork: boolean;
  stargazers_count: number;
}

const token = process.env['GITHUB_PAT'] ?? '';
if (token === '') {
  console.error('GITHUB_PAT is not set.');
  process.exit(1);
}

const client = createGitHubClient({ token });
const entries = readWatchlist();
const now = Date.now();

const problems: { id: string; reason: string }[] = [];
let checked = 0;

for (const entry of entries) {
  let result;
  try {
    result = await client.getJson<FullRepo>(`/repos/${entry.id}`);
  } catch (error) {
    problems.push({ id: entry.id, reason: error instanceof Error ? error.message : 'failed' });
    break;
  }

  checked += 1;

  if (result.status === 'missing') {
    problems.push({ id: entry.id, reason: 'gone: deleted, renamed, or private' });
    continue;
  }
  if (result.status !== 'ok') continue;

  const repo = result.data;

  if (repo.archived) problems.push({ id: entry.id, reason: 'archived' });
  else if (repo.fork) problems.push({ id: entry.id, reason: 'is a fork, not a source project' });
  else if (repo.stargazers_count < CRITERIA.minStars) {
    problems.push({ id: entry.id, reason: `${repo.stargazers_count} stars, below ${CRITERIA.minStars}` });
  } else if (repo.pushed_at !== null) {
    const quiet = Math.round((now - Date.parse(repo.pushed_at)) / 86_400_000);
    if (quiet > CRITERIA.maxQuietDays) {
      problems.push({ id: entry.id, reason: `no push in ${quiet} days` });
    }
  }

  // Canonical casing drifts when a repository is renamed; GitHub redirects
  // silently, so the id we store can quietly stop matching reality.
  if (repo.full_name.toLowerCase() !== entry.id.toLowerCase()) {
    problems.push({ id: entry.id, reason: `renamed to ${repo.full_name}` });
  }
}

console.log(`checked  : ${checked} of ${entries.length}`);
console.log(`requests : ${client.stats().consumed} consumed, ${client.stats().unchanged} unchanged`);
console.log(`remaining: ${client.stats().rateLimitRemaining ?? 'unknown'}`);
console.log('');

if (problems.length === 0) {
  console.log('Every entry meets the stated criteria.');
} else {
  console.log(`${problems.length} entr${problems.length === 1 ? 'y' : 'ies'} to review:`);
  for (const problem of problems) console.log(`  ${problem.id.padEnd(46)} ${problem.reason}`);
  console.log('');
  console.log('Nothing was changed. Removing an entry is an editorial decision');
  console.log('and belongs in a reviewed commit, not in a script.');
}
