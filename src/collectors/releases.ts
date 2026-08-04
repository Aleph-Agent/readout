import {
  BudgetExhaustedError,
  SecondaryRateLimitError,
  type GitHubClient,
  type ReleasePayload,
} from '../lib/github.ts';
import { eventId } from '../lib/ledger.ts';
import type { EventRecord } from '../types/events.ts';
import type { LiveStateRow } from '../types/state.ts';

/**
 * Release collector.
 *
 * A release is directly observed rather than inferred: the API says a tag was
 * published and links to the page. That makes it a fact, so release events go
 * straight to `confirmed` — the confidence ladder exists for statistical
 * claims like spikes, not for things read off an endpoint.
 */

export interface ReleaseCollectionResult {
  /** State rows with release fields filled in. Keyed by repository id. */
  updates: Map<string, Pick<LiveStateRow, 'latestReleaseTag' | 'latestReleaseAt' | 'releaseEtag'>>;
  events: EventRecord[];
  errors: string[];
  stoppedEarly: boolean;
}

export interface ReleaseCollectionOptions {
  /** ISO 8601 UTC for `detectedAt`. Injected so runs are reproducible. */
  now: string;
  /** `YYYY-MM-DD` UTC. Used for the one-slot-per-repository-per-day rule. */
  today: string;
  /**
   * Repositories that already have a release event today. A repository
   * occupies at most one release slot per day however many tags it pushes —
   * otherwise a CI loop retagging twenty times owns the whole feed.
   */
  alreadyReleasedToday: ReadonlySet<string>;
  /** Repositories seen for the first time ever. */
  firstObservation: ReadonlySet<string>;
}

export async function collectReleases(
  client: GitHubClient,
  state: readonly LiveStateRow[],
  options: ReleaseCollectionOptions,
): Promise<ReleaseCollectionResult> {
  const updates: ReleaseCollectionResult['updates'] = new Map();
  const events: EventRecord[] = [];
  const errors: string[] = [];
  let stoppedEarly = false;

  const releasedToday = new Set(options.alreadyReleasedToday);

  for (const row of state) {
    if (!row.active) continue;

    try {
      const result = await client.getJson<ReleasePayload>(
        `/repos/${row.id}/releases/latest`,
        row.releaseEtag,
      );

      if (result.status === 'unchanged') continue;

      if (result.status === 'missing') {
        // No releases have ever been published. Common and not an error.
        updates.set(row.id, {
          latestReleaseTag: row.latestReleaseTag,
          latestReleaseAt: row.latestReleaseAt,
          releaseEtag: null,
        });
        continue;
      }

      const release = result.data;

      updates.set(row.id, {
        latestReleaseTag: release.tag_name,
        latestReleaseAt: release.published_at,
        releaseEtag: result.etag,
      });

      if (release.draft) continue;
      if (release.tag_name === row.latestReleaseTag) continue;

      // Every repository looks like it "just released" the first time it is
      // seen. Recording the tag without emitting an event is what stops the
      // first run from manufacturing 400 headlines out of ordinary history.
      if (options.firstObservation.has(row.id)) continue;

      if (releasedToday.has(row.id)) continue;
      releasedToday.add(row.id);

      events.push({
        id: eventId('release', row.id, release.tag_name),
        kind: 'release',
        repo: row.id,
        detectedAt: options.now,
        confidence: 'confirmed',
        // A prerelease is a real event but rarely worth prose. Marking it
        // skipped keeps the LLM budget for releases people actually adopt.
        summaryState: release.prerelease ? 'skipped' : 'pending',
        summary: null,
        evidenceUrl: release.html_url,
        // The whole evidence base a summary is allowed to explain. Deliberately
        // no release notes: third-party prose is copyrighted, and it is also
        // untrusted input that must never reach a prompt as direction.
        metrics: {
          tag: release.tag_name,
          publishedAt: release.published_at,
          previousTag: row.latestReleaseTag,
          forks: row.forks,
          stars: row.stars,
        },
        supersedes: null,
      });
    } catch (error) {
      if (error instanceof BudgetExhaustedError || error instanceof SecondaryRateLimitError) {
        stoppedEarly = true;
        errors.push(`releases: ${error.message}`);
        break;
      }

      errors.push(`releases ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { updates, events, errors, stoppedEarly };
}
