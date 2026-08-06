/**
 * Fill `packages` on the watchlist, by verification rather than by guess.
 *
 * A mapping from repository to package is a claim that one project's download
 * count belongs to another project's name. Getting it wrong would attribute
 * adoption to the wrong people, silently, on a public page — the worst class of
 * error this project can make, and one nobody would catch because the number
 * would look perfectly plausible.
 *
 * So nothing is written on a name match alone. A candidate name is proposed,
 * the registry's own record for that name is fetched, and the mapping is only
 * kept when the registry says the package comes from this repository. The
 * proposal is cheap and wrong often; the verification is what makes the output
 * usable.
 *
 * Run by hand, not on a schedule:
 *
 *   node scripts/derive-packages.ts            # report only, writes nothing
 *   node scripts/derive-packages.ts --write    # update data/watchlist.jsonl
 *
 * Costs nothing against the GitHub budget: npm, PyPI, crates.io and Homebrew
 * all answer unauthenticated, and Homebrew's whole index is a single file.
 */

import { readWatchlist, writeWatchlist } from '../src/lib/ledger.ts';
import { packageCandidates, pointsBack } from '../src/lib/packages.ts';
import type { WatchlistEntry } from '../src/types/watchlist.ts';

const WRITE = process.argv.includes('--write');

/** Polite, and crates.io rejects requests without one. */
const UA = 'readout-agent (+https://github.com/kaitzyy-dev/readout)';

interface Proposal {
  repo: string;
  registry: string;
  name: string;
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function verifyNpm(repo: string, name: string): Promise<boolean> {
  // The abbreviated document is a fraction of the full one and carries the
  // repository field, which is the only thing being checked.
  const doc = (await getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)) as {
    repository?: { url?: string } | string;
  } | null;
  if (doc === null) return false;

  const declared = typeof doc.repository === 'string' ? doc.repository : doc.repository?.url;
  return pointsBack(declared, repo);
}

async function verifyPypi(repo: string, name: string): Promise<boolean> {
  const doc = (await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)) as {
    info?: { home_page?: string; project_urls?: Record<string, string> };
  } | null;
  if (doc === null) return false;

  const urls = [doc.info?.home_page ?? '', ...Object.values(doc.info?.project_urls ?? {})];
  return urls.some((url) => pointsBack(url, repo));
}

async function verifyCrates(repo: string, name: string): Promise<boolean> {
  const doc = (await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)) as {
    crate?: { repository?: string | null };
  } | null;
  if (doc === null) return false;
  return pointsBack(doc.crate?.repository, repo);
}

/**
 * Homebrew, from the single index file.
 *
 * One request for twenty thousand formulae, so the whole watchlist is checked
 * without a per-repository call. Matched on the formula's declared homepage or
 * source URL rather than on its name: `ffmpeg` the formula and `ffmpeg` the
 * repository are the same thing, but plenty of short names are not.
 */
async function brewIndex(): Promise<Map<string, string>> {
  const formulae = (await getJson('https://formulae.brew.sh/api/formula.json')) as
    | { name: string; homepage?: string; urls?: { stable?: { url?: string } } }[]
    | null;

  const byRepo = new Map<string, string>();
  if (formulae === null) return byRepo;

  for (const formula of formulae) {
    for (const url of [formula.homepage ?? '', formula.urls?.stable?.url ?? '']) {
      const match = /github\.com\/([^/]+\/[^/#?]+?)(?:\.git|\/|$)/i.exec(url);
      const repo = match?.[1]?.toLowerCase();
      // First formula wins. Later duplicates are almost always version-pinned
      // variants — `python@3.11` after `python` — and the unpinned one is the
      // honest answer for "is this project installed via Homebrew".
      if (repo !== undefined && !byRepo.has(repo)) byRepo.set(repo, formula.name);
    }
  }

  return byRepo;
}

async function main(): Promise<void> {
  const watchlist = readWatchlist();
  const active = watchlist.filter((entry) => entry.active);

  process.stdout.write(`Resolving packages for ${active.length} active repositories.\n`);
  process.stdout.write('Fetching the Homebrew index (one request, ~20k formulae)…\n');

  const brew = await brewIndex();
  process.stdout.write(`  ${brew.size} formulae trace back to a GitHub repository.\n\n`);

  const found = new Map<string, string[]>();
  const proposals: Proposal[] = [];

  let checked = 0;
  for (const entry of active) {
    const packages: string[] = [];

    const formula = brew.get(entry.id.toLowerCase());
    if (formula !== undefined) packages.push(`brew:${formula}`);

    for (const name of packageCandidates(entry.id)) {
      // Scoped names only exist on npm, so do not spend three requests on them.
      const scoped = name.startsWith('@');

      if (await verifyNpm(entry.id, name)) {
        packages.push(`npm:${name}`);
        proposals.push({ repo: entry.id, registry: 'npm', name });
        break;
      }
      if (scoped) continue;

      if (await verifyPypi(entry.id, name)) {
        packages.push(`pypi:${name}`);
        proposals.push({ repo: entry.id, registry: 'pypi', name });
        break;
      }
      if (await verifyCrates(entry.id, name)) {
        packages.push(`crates:${name}`);
        proposals.push({ repo: entry.id, registry: 'crates', name });
        break;
      }
    }

    if (packages.length > 0) found.set(entry.id, packages.sort());

    // These are free, unauthenticated services run by other people. Nothing
    // here is urgent, and a one-off script has no business hammering them.
    await new Promise((resolve) => setTimeout(resolve, 60));

    checked += 1;
    if (checked % 25 === 0) {
      process.stdout.write(`  ${checked}/${active.length} checked, ${found.size} mapped\n`);
    }
  }

  const byRegistry: Record<string, number> = {};
  for (const packages of found.values()) {
    for (const packageId of packages) {
      const registry = packageId.split(':')[0] as string;
      byRegistry[registry] = (byRegistry[registry] ?? 0) + 1;
    }
  }

  process.stdout.write(`\nMapped ${found.size} of ${active.length} repositories.\n`);
  for (const [registry, count] of Object.entries(byRegistry).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${registry.padEnd(8)} ${count}\n`);
  }

  const unmapped = active.filter((entry) => !found.has(entry.id));
  process.stdout.write(`\n${unmapped.length} publish nothing this can verify. First 15:\n`);
  for (const entry of unmapped.slice(0, 15)) process.stdout.write(`  ${entry.id}\n`);

  if (!WRITE) {
    process.stdout.write('\nReport only. Pass --write to update the watchlist.\n');
    return;
  }

  const updated: WatchlistEntry[] = watchlist.map((entry) => ({
    ...entry,
    packages: found.get(entry.id) ?? entry.packages ?? [],
  }));

  writeWatchlist(updated);
  process.stdout.write('\nWritten. Review the diff before committing it.\n');
}

await main();
