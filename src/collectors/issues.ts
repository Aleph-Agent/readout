import {
  BudgetExhaustedError,
  SecondaryRateLimitError,
  type GitHubClient,
} from '../lib/github.ts';
import {
  clusterDemand,
  demandEngagements,
  type DemandCluster,
  type IssueSignal,
} from '../lib/demand.ts';
import { eventId } from '../lib/ledger.ts';
import type { EventRecord } from '../types/events.ts';
import type { LiveStateRow } from '../types/state.ts';

/**
 * Demand collector. Daily, never on the pulse.
 *
 * One request per repository against the top slice of the watchlist, sorted by
 * comment count — the core issues endpoint cannot sort by reactions, but it
 * returns reaction totals, so engagement is measured from the payload rather
 * than from the ordering.
 */

/** Budget: one request each, and the daily job has to stay under a thousand. */
const TOP_REPOSITORIES = 80;

const ISSUES_PER_REPO = 10;

export interface IssuesCollectionResult {
  clusters: DemandCluster[];
  /**
   * Engagement of every term that reached the engagement bar, crossing or not.
   *
   * Kept so the threshold can be measured against the population it judges. A
   * day whose busiest candidate scored 12 against a bar of 60 is a day this
   * detector could not have fired whatever developers were asking for.
   */
  engagements: number[];
  events: EventRecord[];
  errors: string[];
  stoppedEarly: boolean;
  requestedRepos: number;
}

export interface IssuesCollectionOptions {
  now: string;
  today: string;
  /** Cluster terms already reported yesterday, for two-run confirmation. */
  previousTerms: ReadonlySet<string>;
  /** Event ids already on disk. */
  seen: ReadonlySet<string>;
}

interface IssuePayload {
  number: number;
  title: string;
  html_url: string;
  comments: number;
  pull_request?: unknown;
  reactions?: { total_count?: number };
}

/**
 * Repositories most likely to be carrying demand: the ones with the largest
 * open-issue surface. Stars would rank by popularity, which is not the same
 * question.
 */
export function topByDemandSurface(state: readonly LiveStateRow[], limit: number): LiveStateRow[] {
  return state
    .filter((row) => row.active)
    .slice()
    .sort((a, b) => b.openIssues - a.openIssues || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}

export async function collectIssues(
  client: GitHubClient,
  state: readonly LiveStateRow[],
  options: IssuesCollectionOptions,
): Promise<IssuesCollectionResult> {
  const targets = topByDemandSurface(state, TOP_REPOSITORIES);
  const signals: IssueSignal[] = [];
  const errors: string[] = [];
  let stoppedEarly = false;
  let requestedRepos = 0;

  for (const row of targets) {
    try {
      const result = await client.getJson<IssuePayload[]>(
        `/repos/${row.id}/issues?state=open&sort=comments&direction=desc&per_page=${ISSUES_PER_REPO}`,
      );
      requestedRepos += 1;

      if (result.status !== 'ok') continue;

      for (const issue of result.data) {
        // The issues endpoint returns pull requests too. A PR is work in
        // progress, not a request for work.
        if (issue.pull_request !== undefined) continue;

        signals.push({
          repo: row.id,
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          reactions: issue.reactions?.total_count ?? 0,
          comments: issue.comments,
        });
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError || error instanceof SecondaryRateLimitError) {
        stoppedEarly = true;
        errors.push(`issues: ${error.message}`);
        break;
      }
      errors.push(`issues ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const clusters = clusterDemand(signals);
  const engagements = demandEngagements(signals);
  const events: EventRecord[] = [];

  for (const cluster of clusters) {
    const id = eventId('demand-cluster', cluster.term, options.today);
    if (options.seen.has(id)) continue;

    events.push({
      id,
      kind: 'demand-cluster',
      // An event keys to one repository. The most-engaged one anchors it; the
      // full span is in the metrics, where it is the actual claim.
      repo: cluster.topRepo,
      detectedAt: options.now,
      confidence: options.previousTerms.has(cluster.term) ? 'confirmed' : 'detected',
      summaryState: options.previousTerms.has(cluster.term) ? 'pending' : 'skipped',
      summary: null,
      summarySource: null,
      evidenceUrl: cluster.topUrl,
      metrics: {
        term: cluster.term,
        repositories: cluster.repos.length,
        issues: cluster.issues,
        engagement: cluster.engagement,
        // Named so the reader knows the claim is about the watchlist, not the
        // world. The watchlist is curated and partial and says so.
        scope: 'watchlist',
      },
      supersedes: null,
    });
  }

  return { clusters, engagements, events, errors, stoppedEarly, requestedRepos };
}
