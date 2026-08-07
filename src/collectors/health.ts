/**
 * Somebody else's assessment of a watched project.
 *
 * Two sources, both free and unauthenticated, and both verified against the
 * live services before this was written:
 *
 *   - deps.dev returns the OpenSSF Scorecard for a repository, keyed by the
 *     GitHub path rather than by a package name — so it covers the whole
 *     watchlist, including the 166 repositories that publish to no registry
 *     this project reads. Not every project has been scanned; unscanned is
 *     reported as unscanned.
 *   - OSV.dev answers advisories in batches. 267 mapped packages cost three
 *     requests, not 267.
 *
 * Neither figure is this project's judgement. Both are cited to the body that
 * made them, which is the only defensible way to publish a claim about someone
 * else's security posture.
 */

import { sleep, ThrottledError } from '../lib/registries.ts';
import { parsePackageId } from './adoption.ts';
import type { HealthRow } from '../types/health.ts';
import type { WatchlistEntry } from '../types/watchlist.ts';

const USER_AGENT = 'sighttrue-agent (+https://github.com/kaitzyy-dev/sighttrue)';

/** deps.dev has no batch form, so the whole watchlist is paced through it. */
export const SCORECARD_DELAY_MS = 150;

/** Verified: OSV accepts a batch. Kept well under anything it might object to. */
export const OSV_BATCH = 100;

/** OSV spells ecosystems its own way. */
const OSV_ECOSYSTEM: Record<string, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  crates: 'crates.io',
};

export interface HealthClient {
  /** Overall score and its date, or null when the project was never scanned. */
  scorecard(repo: string): Promise<{ score: number; at: string | null } | null>;
  /** Advisory counts by `ecosystem/name`, for a batch of packages. */
  advisories(
    packages: readonly { ecosystem: string; name: string }[],
  ): Promise<Map<string, number>>;
  requests(): number;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
  const response = await fetch(url, {
    ...init,
    headers: { 'user-agent': USER_AGENT, ...(init?.headers ?? {}) },
  });

  if (response.status === 404) return null;
  if (response.status === 429 || response.status >= 500) {
    throw new ThrottledError(url, response.status);
  }
  if (!response.ok) return null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createHealthClient(): HealthClient {
  let spent = 0;

  return {
    requests: () => spent,

    async scorecard(repo) {
      spent += 1;
      // Fully encoded: the slash between github.com and the owner has to be
      // escaped too. Leaving it raw returns 400 on every request, which is how
      // the first attempt at this failed on all 388.
      const id = encodeURIComponent(`github.com/${repo}`);
      const body = (await getJson(`https://api.deps.dev/v3alpha/projects/${id}`)) as {
        scorecard?: { overallScore?: number; date?: string };
      } | null;

      const score = body?.scorecard?.overallScore;
      if (typeof score !== 'number') return null;
      return { score, at: body?.scorecard?.date?.slice(0, 10) ?? null };
    },

    async advisories(packages) {
      const out = new Map<string, number>();
      if (packages.length === 0) return out;

      spent += 1;
      const body = (await getJson('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: packages.map((entry) => ({
            package: { name: entry.name, ecosystem: entry.ecosystem },
          })),
        }),
      })) as { results?: { vulns?: unknown[] }[] } | null;

      if (body === null) return out;

      // Results come back positionally, so the request order is the only thing
      // tying a count to a package.
      body.results?.forEach((result, index) => {
        const asked = packages[index];
        if (asked === undefined) return;
        out.set(`${asked.ecosystem}/${asked.name}`, (result.vulns ?? []).length);
      });

      return out;
    },
  };
}

export interface HealthCollectionResult {
  rows: HealthRow[];
  errors: string[];
  requests: number;
}

export interface HealthCollectionOptions {
  now: string;
  client?: HealthClient;
  delayMs?: number;
  /** Cap the watchlist. Used by dry runs. */
  limit?: number;
  /**
   * What the ledger already holds.
   *
   * Required in practice even though the type allows omitting it: this
   * collector overwrites the whole file, so without the previous rows a refused
   * read writes null over a good reading and the loss is invisible.
   */
  previous?: readonly HealthRow[];
}

export async function collectHealth(
  watchlist: readonly WatchlistEntry[],
  options: HealthCollectionOptions,
): Promise<HealthCollectionResult> {
  const client = options.client ?? createHealthClient();
  const errors: string[] = [];

  /**
   * What was recorded last time, so a refused read cannot erase it.
   *
   * This collector overwrites the whole ledger every day, and until this was
   * added it wrote what it had just managed to read — so a refused scorecard
   * replaced yesterday's score with null, and a single failed OSV batch blanked
   * the advisory count for every repository in it at once. Both are the
   * absent-versus-empty rule broken in the direction that loses data: null here
   * means "recorded and empty", and the reads were neither.
   *
   * Nothing about it looks like a failure. The row is still there, the page
   * still renders, and the figure is a dash — which reads as "this project has
   * no scorecard" rather than "we could not reach the service".
   */
  const before = new Map((options.previous ?? []).map((row) => [row.id, row]));

  const active = watchlist.filter((entry) => entry.active);
  const scope = options.limit === undefined ? active : active.slice(0, options.limit);

  // Advisories first: one batched pass over every mapped package, so a
  // repository's count is ready before its row is built.
  const wanted: { ecosystem: string; name: string; repo: string }[] = [];
  for (const entry of scope) {
    for (const packageId of entry.packages ?? []) {
      const parsed = parsePackageId(packageId);
      // Homebrew is a distribution channel, not an ecosystem OSV tracks.
      const ecosystem = parsed === null ? undefined : OSV_ECOSYSTEM[parsed.registry];
      if (parsed === null || ecosystem === undefined) continue;
      wanted.push({ ecosystem, name: parsed.name, repo: entry.id });
    }
  }

  const counts = new Map<string, number>();

  // Which repositories had a package in a batch that failed. Tracked per batch
  // rather than as one flag: one refused request out of three must not discard
  // the two that answered, and a repository whose packages all came back is a
  // repository whose count is complete.
  const unread = new Set<string>();

  for (let i = 0; i < wanted.length; i += OSV_BATCH) {
    const batch = wanted.slice(i, i + OSV_BATCH);
    try {
      const found = await client.advisories(batch);
      for (const [key, count] of found) counts.set(key, count);
    } catch (error) {
      for (const entry of batch) unread.add(entry.repo);
      errors.push(
        `health osv: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const advisoriesByRepo = new Map<string, number>();
  for (const entry of wanted) {
    const count = counts.get(`${entry.ecosystem}/${entry.name}`);
    if (count === undefined) continue;
    advisoriesByRepo.set(entry.repo, (advisoriesByRepo.get(entry.repo) ?? 0) + count);
  }

  const rows: HealthRow[] = [];
  let refused = 0;

  for (const [index, entry] of scope.entries()) {
    if (index > 0) await sleep(options.delayMs ?? SCORECARD_DELAY_MS);

    const last = before.get(entry.id);

    let scorecard: number | null = null;
    let scoredAt: string | null = null;

    try {
      const found = await client.scorecard(entry.id);
      // A null here is deps.dev saying the project was never scanned, which is
      // a reading. Only a thrown error means we failed to ask.
      if (found !== null) {
        scorecard = found.score;
        scoredAt = found.at;
      }
    } catch (error) {
      // Refused is not the same as never scanned, and the row must not claim
      // the second when it means the first. Yesterday's score stands until
      // somebody manages to read a new one.
      refused += 1;
      scorecard = last?.scorecard ?? null;
      scoredAt = last?.scoredAt ?? null;

      if (!(error instanceof ThrottledError)) {
        errors.push(
          `health scorecard ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Same rule for advisories. `undefined` from the map is either "no
    // advisories" or "the batch never answered", and only the second may carry
    // forward — otherwise a service outage looks like every project suddenly
    // being clean, which is the most dangerous possible way to be wrong here.
    const advisories = unread.has(entry.id)
      ? (last?.advisories ?? null)
      : (advisoriesByRepo.get(entry.id) ?? null);

    rows.push({
      id: entry.id,
      scorecard,
      scoredAt,
      advisories,
      observedAt: options.now,
    });
  }

  if (refused > 0) {
    errors.push(`health scorecard: refused ${refused} of ${scope.length} reads`);
  }

  return { rows, errors, requests: client.requests() };
}
