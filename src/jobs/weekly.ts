import { collectContributors } from '../collectors/contributors.ts';
import { collectTrending } from '../collectors/trending.ts';
import { collectLineage, DEFAULT_LINEAGE_THRESHOLDS } from '../collectors/lineage.ts';
import { createGitHubClient, type GitHubClient } from '../lib/github.ts';
import { createHuggingFaceClient, type HuggingFaceClient } from '../lib/huggingface.ts';
import { summariseCalibration } from '../lib/calibration.ts';
import {
  appendCalibration,
  appendEvents,
  readAllEvents,
  readLineageRoots,
  readMeta,
  writeLineageRoots,
  readActiveWatchlist,
  readContributors,
  readTrending,
  writeContributors,
  writeTrending,
  writeMeta,
} from '../lib/ledger.ts';
import { utcDate, utcMonth } from '../lib/paths.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * The weekly job: model descent.
 *
 * Weekly because descent moves at the speed of people training models, and
 * because a daily read would report noise as news. The cadence table has had a
 * weekly row since the beginning; this is the job that fills it.
 *
 * Costs nothing against the GitHub budget — it talks to Hugging Face only.
 */

export interface WeeklyOptions {
  now?: Date;
  client?: HuggingFaceClient;
  /** GitHub client for the contributor read. Omit to build one from the token. */
  githubClient?: GitHubClient;
  /** Skip the contributor read. Lineage still runs. */
  offline?: boolean;
  token?: string;
}

export async function runWeekly(options: WeeklyOptions = {}): Promise<MetaRecord> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const today = utcDate(now);
  const month = utcMonth(now);

  const client =
    options.client ??
    createHuggingFaceClient({ token: options.token ?? process.env['HF_TOKEN'] ?? '' });

  const roots = readLineageRoots();
  const seen = new Set(readAllEvents().map((event) => event.id));

  const result = await collectLineage(client, roots, { now: nowIso, today, seen });

  writeLineageRoots(result.roots);
  if (result.events.length > 0) appendEvents(month, result.events);

  // What every root gained this week, crossing the bar or not. A quarter where
  // nothing ever gained more than two models is a fact about `minNew`, not
  // about model lineage, and it is only knowable if the weeks were recorded.
  try {
    appendCalibration([
      summariseCalibration(
        today,
        'lineage',
        'new descendants this week',
        DEFAULT_LINEAGE_THRESHOLDS.minNew,
        result.observations,
      ),
    ]);
  } catch (error) {
    // Never fatal: losing a diagnostic must not lose the run that produced it.
    result.errors.push(
      `calibration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // How concentrated each project's commit history is. Weekly rather than
  // daily: the shape of a decade of commits does not move overnight, and one
  // request per repository is not worth spending six times a day to learn.
  if (options.offline !== true) {
    try {
      const github =
        options.githubClient ??
        createGitHubClient({ token: process.env['GITHUB_PAT'] ?? '' });
      const held = readContributors();
      const concentrated = await collectContributors(held, {
        now: nowIso,
        client: github,
        repos: readActiveWatchlist().map((entry) => entry.id),
      });
      // Same rule as every other ledger here: a run that read nothing is a
      // network problem, not four hundred projects that lost their history.
      writeContributors(concentrated.rows.length === 0 ? held : concentrated.rows);
      result.errors.push(...concentrated.errors);
    } catch (error) {
      result.errors.push(
        `contributors: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // What somebody else says is trending, with the column their list cannot
  // carry. OSSInsight is free and unauthenticated and there is no point
  // competing with ten billion GitHub events — the list is theirs, credited,
  // and taken unaltered. The bus factor is what this adds.
  if (options.offline !== true) {
    try {
      const github =
        options.githubClient ??
        createGitHubClient({ token: process.env['GITHUB_PAT'] ?? '' });
      const trending = await collectTrending({ now: nowIso, readAt: today, github });
      // A week that read nothing keeps the week before it. An empty trending
      // list would read as a week in which nothing trended, which never
      // happens and would be false if recorded.
      if (trending.rows.length > 0) writeTrending([...readTrending(), ...trending.rows]);
      result.errors.push(...trending.errors);
    } catch (error) {
      result.errors.push(`trending: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const previous = readMeta();
  const meta: MetaRecord = {
    ...previous,
    lastRunAt: nowIso,
    lastSuccessfulRunAt: result.errors.length > 0 ? previous.lastSuccessfulRunAt : nowIso,
    job: 'weekly',
    partial: result.errors.length > 0,
    reposChecked: roots.filter((root) => root.active).length,
    eventsDetected: result.events.length,
    collectorsErrored: result.errors,
  };

  writeMeta(meta);
  return meta;
}
