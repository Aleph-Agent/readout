/**
 * What is trending, and who is actually writing it.
 *
 * OSSInsight publishes the best trending data there is — ten billion GitHub
 * events, a composite momentum score, free and unauthenticated. There is no
 * point competing with it and this does not try: the list is theirs, credited
 * as theirs, and taken unaltered.
 *
 * What a trending list cannot tell you is the thing that decides whether
 * adopting something is sensible. Momentum measures attention. It says nothing
 * about whether the project is one person, and something that appeared from
 * nowhere is very often exactly that.
 *
 * So one column is added and it is the one that changes the decision: how many
 * contributors account for half the commits. "Rising, and one person wrote 98%
 * of it" is a different sentence from "rising".
 *
 * Three months rather than a week, and that was decided by the data rather than
 * by taste. The weekly window is dominated by repositories five days old with
 * nine stars, where a bus factor of one is a fact about the calendar and not
 * about the project — the top of the Rust list one week ran 29 stars, 13, 5, 2.
 * Over three months the same list starts at 2,902, which is a project somebody
 * might actually adopt, which is the only case where the added column means
 * anything.
 *
 * Weekly cadence against a three-month window is deliberate: the window moves
 * slowly, so reading it daily would spend requests watching the same quarter.
 */

import type { GitHubClient } from '../lib/github.ts';
import type { TrendingRow } from '../types/trending.ts';
import { collectContributors } from './contributors.ts';
import { sleep } from '../lib/registries.ts';

const API = 'https://api.ossinsight.io/v1/trends/repos/';
const USER_AGENT = 'readout-agent (+https://github.com/kaitzyy-dev/readout)';

export const DELAY_MS = 400;

/**
 * Languages read. One request each, and each returns a hundred repositories.
 *
 * Chosen to match what this watchlist and its readers are already made of
 * rather than to survey GitHub, which is what OSSInsight is for.
 */
export const LANGUAGES = ['TypeScript', 'Python', 'Rust', 'Go'] as const;

/**
 * Repositories taken per language, off the top of their ranking.
 *
 * The tail of a trending list is projects with four stars and one push. Reading
 * a hundred of those per language would spend two hundred GitHub requests to
 * report the bus factor of things nobody has heard of.
 */
export const PER_LANGUAGE = 8;

/** Below this a bus factor is a fact about a new repository, not a warning. */
export const MIN_GAINED = 250;

interface TrendRow {
  repo_name?: unknown;
  primary_language?: unknown;
  stars?: unknown;
  total_score?: unknown;
}

export interface TrendingClient {
  /** Trending repositories for one language, this past week. */
  trending(language: string): Promise<{ id: string; starsGained: number; score: number }[] | null>;
  requests(): number;
}

export function createTrendingClient(): TrendingClient {
  let spent = 0;
  return {
    requests: () => spent,
    async trending(language) {
      spent += 1;
      const response = await fetch(
        `${API}?language=${encodeURIComponent(language)}&period=past_3_months`,
        { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } },
      );
      // The status travels with the failure. "Unavailable" told us four
      // languages had failed and nothing about whether that was a rate limit, a
      // block, or an outage — three problems with three different answers.
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());

      const body = (await response.json()) as { data?: { rows?: TrendRow[] } };
      return (body.data?.rows ?? [])
        .map((row) => ({
          id: typeof row.repo_name === 'string' ? row.repo_name : '',
          starsGained: Number.parseInt(String(row.stars ?? '0'), 10) || 0,
          score: Number.parseFloat(String(row.total_score ?? '0')) || 0,
        }))
        .filter((row) => row.id.includes('/'));
    },
  };
}

export interface TrendingCollectionResult {
  rows: TrendingRow[];
  errors: string[];
  requests: number;
}

export interface TrendingCollectionOptions {
  now: string;
  /** `YYYY-MM-DD` the window was read on. */
  readAt: string;
  /** Reads contributor histories. Omit to record the list with no bus factor. */
  github?: GitHubClient;
  client?: TrendingClient;
  languages?: readonly string[];
  perLanguage?: number;
  delayMs?: number;
}

export async function collectTrending(
  options: TrendingCollectionOptions,
): Promise<TrendingCollectionResult> {
  const client = options.client ?? createTrendingClient();
  const languages = options.languages ?? LANGUAGES;
  const perLanguage = options.perLanguage ?? PER_LANGUAGE;
  const errors: string[] = [];

  const picked: { id: string; language: string; starsGained: number; score: number }[] = [];

  for (const [index, language] of languages.entries()) {
    if (index > 0) await sleep(options.delayMs ?? DELAY_MS);

    let rows: { id: string; starsGained: number; score: number }[] | null;
    try {
      rows = await client.trending(language);
    } catch (error) {
      errors.push(
        `trending ${language}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (rows === null) {
      errors.push(`trending ${language}: unavailable`);
      continue;
    }

    for (const row of rows.filter((entry) => entry.starsGained >= MIN_GAINED).slice(0, perLanguage)) {
      picked.push({ ...row, language });
    }
  }

  // Nothing read means nothing to say. Writing an empty week over a full one
  // would look identical to a week in which nothing trended, which never
  // happens and would be a lie if it were recorded.
  if (picked.length === 0) {
    return { rows: [], errors, requests: client.requests() };
  }

  // The added column. Reuses the contributor reader rather than a second copy
  // of the same arithmetic — a bus factor computed two ways is two numbers.
  const concentration = new Map<string, { busFactor: number; topShare: number }>();

  if (options.github !== undefined) {
    const read = await collectContributors([], {
      now: options.now,
      client: options.github,
      repos: picked.map((entry) => entry.id),
    });
    errors.push(...read.errors);
    for (const row of read.rows) {
      concentration.set(row.id, { busFactor: row.busFactor, topShare: row.topShare });
    }
  }

  const rows: TrendingRow[] = picked.map((entry) => {
    const shape = concentration.get(entry.id);
    return {
      id: entry.id,
      language: entry.language,
      score: Math.round(entry.score * 10) / 10,
      starsGained: entry.starsGained,
      // Null rather than a guess. A repository too new for a contributor read,
      // or one the budget did not reach, is unread — not evenly maintained.
      busFactor: shape?.busFactor ?? null,
      topShare: shape?.topShare ?? null,
      readAt: options.readAt,
      observedAt: options.now,
    };
  });

  return { rows, errors, requests: client.requests() };
}
