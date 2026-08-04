import {
  BudgetExhaustedError,
  SecondaryRateLimitError,
  type GitHubClient,
  type RepoPayload,
} from '../lib/github.ts';
import type { LiveStateRow } from '../types/state.ts';
import type { WatchlistEntry } from '../types/watchlist.ts';

/**
 * Repo base collector.
 *
 * One call to `GET /repos/{owner}/{repo}` returns forks, stars, open issues,
 * and last push — four of the five signals from a single request. This is the
 * whole argument for a unified agent rather than five separate collectors.
 */

export interface BaseCollectionResult {
  rows: LiveStateRow[];
  /** Repositories that answered 404 and were marked inactive this run. */
  missing: string[];
  /** Per-repository failures. One bad repository must not abort the rest. */
  errors: string[];
  /** True when the run stopped on budget rather than finishing the watchlist. */
  stoppedEarly: boolean;
}

function rowFromPayload(
  entry: WatchlistEntry,
  payload: RepoPayload,
  etag: string | null,
  previous: LiveStateRow | undefined,
): LiveStateRow {
  return {
    id: entry.id,
    active: true,
    forks: payload.forks_count,
    stars: payload.stargazers_count,
    openIssues: payload.open_issues_count,
    pushedAt: payload.pushed_at,
    // Release fields belong to the releases collector. Carrying them forward
    // keeps one collector from erasing another's output.
    latestReleaseTag: previous?.latestReleaseTag ?? null,
    latestReleaseAt: previous?.latestReleaseAt ?? null,
    etag,
    releaseEtag: previous?.releaseEtag ?? null,
  };
}

function inactiveRow(entry: WatchlistEntry, previous: LiveStateRow | undefined): LiveStateRow {
  return {
    id: entry.id,
    active: false,
    forks: previous?.forks ?? 0,
    stars: previous?.stars ?? 0,
    openIssues: previous?.openIssues ?? 0,
    pushedAt: previous?.pushedAt ?? null,
    latestReleaseTag: previous?.latestReleaseTag ?? null,
    latestReleaseAt: previous?.latestReleaseAt ?? null,
    // Both validators are dropped: whatever they referred to is gone.
    etag: null,
    releaseEtag: null,
  };
}

export async function collectBase(
  client: GitHubClient,
  entries: readonly WatchlistEntry[],
  previousState: ReadonlyMap<string, LiveStateRow>,
): Promise<BaseCollectionResult> {
  const rows: LiveStateRow[] = [];
  const missing: string[] = [];
  const errors: string[] = [];
  let stoppedEarly = false;

  for (const entry of entries) {
    const previous = previousState.get(entry.id);

    try {
      const result = await client.getJson<RepoPayload>(
        `/repos/${entry.id}`,
        previous?.etag ?? null,
      );

      if (result.status === 'unchanged') {
        // Nothing moved and nothing was spent. Carry the row forward byte for
        // byte so it contributes no diff.
        if (previous) rows.push(previous);
        continue;
      }

      if (result.status === 'missing') {
        // Deleted, renamed, or gone private. Record it and keep going — the
        // watchlist is curated by hand and will always drift.
        missing.push(entry.id);
        rows.push(inactiveRow(entry, previous));
        continue;
      }

      rows.push(rowFromPayload(entry, result.data, result.etag, previous));
    } catch (error) {
      if (error instanceof BudgetExhaustedError || error instanceof SecondaryRateLimitError) {
        // Stop cleanly and write what was collected. A partial run is a normal
        // outcome; pushing past the budget is not.
        stoppedEarly = true;
        errors.push(`base: ${error.message}`);
        break;
      }

      errors.push(`base ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
      if (previous) rows.push(previous);
    }
  }

  // Repositories never reached — budget ran out — keep their previous readings
  // rather than vanishing from the ledger.
  const collected = new Set(rows.map((row) => row.id));
  for (const [id, row] of previousState) {
    if (!collected.has(id)) rows.push(row);
  }

  return { rows, missing, errors, stoppedEarly };
}
