/**
 * Derive the watchlist from recorded queries instead of from memory.
 *
 *   node scripts/derive-watchlist.ts            # candidate + diff, writes nothing
 *   node scripts/derive-watchlist.ts --write    # replaces data/watchlist.jsonl
 *
 * The original 400 entries were written out from an LLM's recollection. 399 of
 * them turned out to exist, which was luck rather than method, and in a project
 * whose every published number can be checked in ten seconds the foundation of
 * every measurement should not be the one thing nobody can reproduce.
 *
 * These queries are the method. They are stored here, they run against the
 * public search API, and anyone can run them again and get the same list. The
 * result is still an editorial claim — the queries were chosen, the thresholds
 * were chosen — but it is now a claim with a stated basis.
 *
 * Search is a separate, smaller rate bucket than the core API: 30 requests a
 * minute. This makes roughly fifteen, spaced, once.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { createGitHubClient } from '../src/lib/github.ts';
import { readWatchlist, writeWatchlist } from '../src/lib/ledger.ts';
import { isSafeRepoId, WATCHLIST_PATH } from '../src/lib/paths.ts';
import { writeJson } from '../src/lib/jsonl.ts';
import { join } from 'node:path';
import { DATA_DIR } from '../src/lib/paths.ts';
import type { Category, WatchlistEntry } from '../src/types/watchlist.ts';

/** How many repositories each category contributes. */
const PER_CATEGORY = 80;

/** Enough adoption that activity means something, low enough to reach 80. */
const MIN_STARS = 1_000;

/**
 * Pushed within roughly the last quarter.
 *
 * The single most effective filter against teaching material. A course or a
 * book gathers stars for years and stops changing; software that is worth
 * watching is software that moves.
 */
const ACTIVE_SINCE = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);

/**
 * Sorting by stars selects for popularity, and the most-starred repositories on
 * GitHub are tutorials, courses and link collections rather than software. A
 * fork spike on an awesome-list means somebody bookmarked it.
 *
 * This is a crude filter and it is stated rather than hidden, which is the
 * point: anyone re-running the derivation can see exactly what was excluded and
 * disagree with it.
 */
const NOT_SOFTWARE =
  /(^|[-_/])(awesome|tutorials?|courses?|books?|guides?|roadmaps?|cheat[-_]?sheets?|examples?|learn|learning|beginners?|handbook|interview|notes|papers?|resources?|collection|list)([-_/]|$)/i;

/** Prose and notebooks are content. Software has a programming language. */
const NOT_A_LANGUAGE = new Set(['Markdown', 'HTML', 'CSS', 'TeX', 'Jupyter Notebook', null]);

/**
 * One or more queries per category, in priority order. Results are merged and
 * de-duplicated, keeping the highest-starred first, until the quota is filled.
 */
const QUERIES: Record<Category, readonly string[]> = {
  'ai-ml': [
    'topic:machine-learning',
    'topic:deep-learning',
    'topic:llm',
    'topic:pytorch',
  ],
  'web-framework': [
    'topic:web-framework',
    'topic:frontend-framework',
    'topic:http-server',
  ],
  database: ['topic:database', 'topic:sql', 'topic:orm'],
  devtool: ['topic:developer-tools', 'topic:cli', 'topic:devops'],
  'crypto-web3': ['topic:ethereum', 'topic:blockchain', 'topic:web3'],
};

interface SearchResult {
  items: {
    full_name: string;
    stargazers_count: number;
    archived: boolean;
    fork: boolean;
    language: string | null;
    open_issues_count: number;
  }[];
}

const token = process.env['GITHUB_PAT'] ?? '';
if (token === '') {
  console.error('GITHUB_PAT is not set.');
  process.exit(1);
}

const client = createGitHubClient({ token });
const write = process.argv.includes('--write');
const today = new Date().toISOString().slice(0, 10);

const derived: WatchlistEntry[] = [];
const taken = new Set<string>();
const perQuery: Record<string, number> = {};

for (const [category, queries] of Object.entries(QUERIES) as [Category, readonly string[]][]) {
  const picked: string[] = [];

  for (const topic of queries) {
    if (picked.length >= PER_CATEGORY) break;

    const q = encodeURIComponent(`${topic} stars:>${MIN_STARS} pushed:>${ACTIVE_SINCE}`);
    const path = `/search/repositories?q=${q}&sort=stars&order=desc&per_page=100`;

    const result = await client.getJson<SearchResult>(path);
    // Spacing matters: search is 30/minute and tripping it restricts the token
    // beyond this run.
    await sleep(2500);

    if (result.status !== 'ok') {
      console.warn(`  ${topic}: ${result.status}`);
      continue;
    }

    let added = 0;
    for (const item of result.data.items) {
      if (picked.length >= PER_CATEGORY) break;
      // Archives and forks are not projects with activity to read.
      if (item.archived || item.fork) continue;
      if (!isSafeRepoId(item.full_name)) continue;
      if (NOT_SOFTWARE.test(item.full_name)) continue;
      if (NOT_A_LANGUAGE.has(item.language)) continue;
      // Software people use accumulates issues. Content does not.
      if (item.open_issues_count < 5) continue;

      const key = item.full_name.toLowerCase();
      if (taken.has(key)) continue;

      taken.add(key);
      picked.push(item.full_name);
      added += 1;
    }

    perQuery[`${category}: ${topic}`] = added;
    console.log(`  ${category.padEnd(14)} ${topic.padEnd(28)} +${added}`);
  }

  for (const id of picked) {
    derived.push({ id, category, added: today, active: true, packages: [] });
  }
}

const current = readWatchlist();
const currentIds = new Set(current.map((e) => e.id.toLowerCase()));
const derivedIds = new Set(derived.map((e) => e.id.toLowerCase()));

const kept = derived.filter((e) => currentIds.has(e.id.toLowerCase()));
const gained = derived.filter((e) => !currentIds.has(e.id.toLowerCase()));
const lost = current.filter((e) => !derivedIds.has(e.id.toLowerCase()));

console.log('');
console.log(`current  : ${current.length}`);
console.log(`derived  : ${derived.length}`);
console.log(`unchanged: ${kept.length}`);
console.log(`new      : ${gained.length}`);
console.log(`dropped  : ${lost.length}`);

if (gained.length > 0) {
  console.log('\nfirst 15 new:');
  for (const e of gained.slice(0, 15)) console.log(`  + ${e.id}`);
}
if (lost.length > 0) {
  console.log('\nfirst 15 dropped:');
  for (const e of lost.slice(0, 15)) console.log(`  - ${e.id}`);
}

if (!write) {
  console.log('\nNothing written. Re-run with --write to replace the watchlist.');
} else {
  // Entries already on the list keep their original added date: it records
  // when watching began, not when this script last ran.
  const previousDates = new Map(current.map((e) => [e.id.toLowerCase(), e.added]));
  writeWatchlist(
    derived.map((e) => ({ ...e, added: previousDates.get(e.id.toLowerCase()) ?? today })),
  );

  writeJson(
    join(DATA_DIR, 'watchlist-provenance.json'),
    {
      derivedAt: new Date().toISOString(),
      method: 'GitHub repository search, sorted by stars, archives and forks excluded',
      minStars: MIN_STARS,
      perCategory: PER_CATEGORY,
      queries: QUERIES as unknown as Record<string, readonly string[]>,
      yieldPerQuery: perQuery,
      total: derived.length,
    },
    ['derivedAt', 'method', 'minStars', 'perCategory', 'queries', 'yieldPerQuery', 'total'],
  );

  console.log(`\nWrote ${derived.length} entries to ${WATCHLIST_PATH}`);
  console.log('Provenance recorded in data/watchlist-provenance.json');
}
