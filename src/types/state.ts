import type { AssertExhaustive } from './keys.ts';

/**
 * One line of `data/live/state.jsonl` — the most recent reading for a
 * repository. Overwritten every pulse, sorted by repository id.
 *
 * DELIBERATELY ABSENT: a per-row `checkedAt` timestamp.
 *
 * A timestamp that moves every pulse would rewrite all ~400 lines six times a
 * day, which is exactly the churn the sorted/fixed-key layout exists to avoid.
 * Run timing belongs to `meta.json`, which is one small file per run. Any field
 * added here must be one that changes only when the repository changes.
 */
export interface LiveStateRow {
  /** Canonical `owner/repo`. Matches `WatchlistEntry.id`. */
  id: string;
  /** Mirrors the watchlist. False after a 404; the row is kept, not deleted. */
  active: boolean;
  forks: number;
  stars: number;
  openIssues: number;
  /** ISO 8601 UTC of the repository's last push, straight from GitHub. */
  pushedAt: string | null;
  /** Tag name of the most recent release, or null if it has never released. */
  latestReleaseTag: string | null;
  /** ISO 8601 UTC the most recent release was published. */
  latestReleaseAt: string | null;
  /**
   * ETag from the last `GET /repos/{owner}/{repo}`, replayed as
   * `If-None-Match`. A 304 costs no rate-limit budget, which is the single
   * largest saving available at this cadence.
   *
   * Known tradeoff: GitHub rotates this on any payload change, including
   * fields we never read, so it churns slightly more than the signal fields do.
   * Measure the real churn during Prompt 2 before deciding whether it earns its
   * own file.
   */
  etag: string | null;
}

export const LIVE_STATE_KEYS = [
  'id',
  'active',
  'forks',
  'stars',
  'openIssues',
  'pushedAt',
  'latestReleaseTag',
  'latestReleaseAt',
  'etag',
] as const satisfies readonly (keyof LiveStateRow)[];

export type _LiveStateKeysExhaustive = AssertExhaustive<
  Exclude<keyof LiveStateRow, (typeof LIVE_STATE_KEYS)[number]>
>;
