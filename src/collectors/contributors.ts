/**
 * How many people a project would survive losing.
 *
 * Every health signal in circulation measures activity — commits, stars,
 * releases, issue throughput. None of them measures who is producing it, and
 * that is the difference between a project that survives its maintainer taking
 * a job and one that quietly stops. Ten thousand commits from one person and
 * ten thousand from forty look identical on every chart there is.
 *
 * The bus factor as usually defined: how many contributors, counting from the
 * most prolific down, it takes to account for half the commits. One means half
 * this project's history came from a single person.
 *
 * What it is not, and the page has to say so. Commit count is not contribution
 * — review, triage, documentation and maintenance leave few commits and a
 * project cannot run without them. It is history rather than the present: a
 * founder who left three years ago still dominates the count. And a low number
 * is a fact about concentration, not an accusation about anybody.
 */

import type { ContributorRow } from '../types/contributors.ts';
import type { GitHubClient } from '../lib/github.ts';

/**
 * Contributors read per repository, in one request.
 *
 * GitHub's own cap for this endpoint. Beyond it the tail is a long list of
 * people with one commit each, which cannot change a bus factor computed from
 * the top of the distribution — so paging further would spend requests to
 * refine a number that is already settled.
 */
export const PAGE_SIZE = 100;

/** Below this the shares are noise; a project with nine commits has no shape. */
export const MIN_COMMITS = 25;

interface Contributor {
  contributions?: unknown;
}

export interface ContributorCollectionResult {
  rows: ContributorRow[];
  errors: string[];
}

export interface ContributorCollectionOptions {
  now: string;
  client: GitHubClient;
  /** Repositories read this run. The weekly job passes them all. */
  repos: readonly string[];
}

/**
 * Contributors accounting for half the commits, and the largest one's share.
 *
 * Returns null below `MIN_COMMITS`, because a share of nine commits is a
 * property of the sample rather than of the project.
 */
export function concentration(
  contributions: readonly number[],
): { busFactor: number; topShare: number; commits: number } | null {
  const sorted = [...contributions].filter((value) => value > 0).sort((a, b) => b - a);
  const commits = sorted.reduce((sum, value) => sum + value, 0);
  if (commits < MIN_COMMITS) return null;

  const half = commits / 2;
  let running = 0;
  let busFactor = 0;

  for (const value of sorted) {
    running += value;
    busFactor += 1;
    if (running >= half) break;
  }

  return {
    busFactor,
    topShare: Math.round(((sorted[0] as number) / commits) * 1000) / 1000,
    commits,
  };
}

export async function collectContributors(
  previous: readonly ContributorRow[],
  options: ContributorCollectionOptions,
): Promise<ContributorCollectionResult> {
  const errors: string[] = [];
  const held = new Map(previous.map((row) => [row.id, row]));
  const rows: ContributorRow[] = [];

  for (const repo of options.repos) {
    // The budget floor is the client's own; once it trips, every remaining
    // repository keeps its last reading rather than being recorded as unread.
    if (options.client.isExhausted()) {
      const previousRow = held.get(repo);
      if (previousRow !== undefined) rows.push(previousRow);
      continue;
    }

    let fetched;
    try {
      fetched = await options.client.getJson<Contributor[]>(
        `/repos/${repo}/contributors?per_page=${PAGE_SIZE}&anon=0`,
      );
    } catch (error) {
      errors.push(
        `contributors ${repo}: ${error instanceof Error ? error.message : String(error)}`,
      );
      const previousRow = held.get(repo);
      if (previousRow !== undefined) rows.push(previousRow);
      continue;
    }

    if (fetched.status !== 'ok') {
      // A 404 here is an archived or renamed repository, and a 304 means
      // nothing changed. Neither is a project that lost its contributors.
      const previousRow = held.get(repo);
      if (previousRow !== undefined) rows.push(previousRow);
      continue;
    }

    const contributions = fetched.data
      .map((entry: Contributor) => (typeof entry.contributions === 'number' ? entry.contributions : 0))
      .filter((value) => value > 0);

    const reading = concentration(contributions);
    if (reading === null) {
      const previousRow = held.get(repo);
      if (previousRow !== undefined) rows.push(previousRow);
      continue;
    }

    rows.push({
      id: repo,
      busFactor: reading.busFactor,
      topShare: reading.topShare,
      contributors: contributions.length,
      commits: reading.commits,
      // At the cap the tail is unread, so the contributor count is a floor. The
      // bus factor is not affected — it is decided at the top of the
      // distribution — but the count printed beside it would be a lie.
      truncated: contributions.length >= PAGE_SIZE,
      observedAt: options.now,
    });
  }

  return { rows, errors };
}
