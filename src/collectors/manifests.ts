import {
  BudgetExhaustedError,
  SecondaryRateLimitError,
  type GitHubClient,
} from '../lib/github.ts';
import { eventId } from '../lib/ledger.ts';
import { diffDependencies, manifestPathFor, parseManifest } from '../lib/manifests.ts';
import type { EventRecord } from '../types/events.ts';
import type { ManifestRow } from '../types/manifests.ts';
import type { LiveStateRow } from '../types/state.ts';

/**
 * Dependency collector. Daily, never on the pulse — manifests barely change,
 * and polling them six times a day would spend two thousand requests to watch
 * files sit still.
 *
 * One request per repository, against the manifest its reported language
 * implies. Never the Code Search API: it is capped at ten requests a minute,
 * and searching GitHub globally would support a claim about the whole ecosystem
 * that this project cannot defend. What it can defend is what the watchlist is
 * doing, and that is what it says.
 */

const MAX_NAMED_IN_EVENT = 6;

export interface ManifestCollectionResult {
  rows: ManifestRow[];
  events: EventRecord[];
  errors: string[];
  stoppedEarly: boolean;
  /** Repositories whose language maps to no manifest we can parse. */
  unsupported: number;
}

export interface ManifestCollectionOptions {
  now: string;
  today: string;
  seen: ReadonlySet<string>;
}

interface ContentsPayload {
  content?: string;
  encoding?: string;
}

export async function collectManifests(
  client: GitHubClient,
  state: readonly LiveStateRow[],
  previous: ReadonlyMap<string, ManifestRow>,
  options: ManifestCollectionOptions,
): Promise<ManifestCollectionResult> {
  const rows: ManifestRow[] = [];
  const events: EventRecord[] = [];
  const errors: string[] = [];
  let stoppedEarly = false;
  let unsupported = 0;

  for (const row of state) {
    if (!row.active) continue;

    const path = manifestPathFor(row.language);
    const before = previous.get(row.id);

    if (path === null) {
      unsupported += 1;
      // Recorded rather than skipped, so coverage is visible instead of implied.
      rows.push({ id: row.id, path: null, deps: {}, etag: null, readAt: null });
      continue;
    }

    try {
      const result = await client.getJson<ContentsPayload>(
        `/repos/${row.id}/contents/${path}`,
        before?.path === path ? before.etag : null,
      );

      if (result.status === 'unchanged') {
        if (before) rows.push(before);
        continue;
      }

      if (result.status === 'missing') {
        rows.push({ id: row.id, path: null, deps: {}, etag: null, readAt: options.today });
        continue;
      }

      const encoded = result.data.content;
      if (typeof encoded !== 'string') {
        rows.push({ id: row.id, path, deps: before?.deps ?? {}, etag: result.etag, readAt: options.today });
        continue;
      }

      const text = Buffer.from(encoded, 'base64').toString('utf8');
      const deps = parseManifest(path, text);

      rows.push({ id: row.id, path, deps, etag: result.etag, readAt: options.today });

      // Nothing to diff against on first sight. Recording the set without
      // emitting an event is what stops the first run from declaring every
      // dependency in the watchlist a migration.
      if (before === undefined || before.path !== path || before.readAt === null) continue;

      const diff = diffDependencies(before.deps, deps);
      const changes = diff.added.length + diff.removed.length + diff.bumped.length;
      if (changes === 0) continue;

      const id = eventId('dependency-shift', row.id, options.today);
      if (options.seen.has(id)) continue;

      events.push({
        id,
        kind: 'dependency-shift',
        repo: row.id,
        detectedAt: options.now,
        // Read directly out of a manifest with a link to it. A fact, not an
        // inference, so it does not climb the confidence ladder.
        confidence: 'confirmed',
        summaryState: changes >= 2 ? 'pending' : 'skipped',
        summary: null,
        evidenceUrl: `https://github.com/${row.id}/blob/HEAD/${path}`,
        metrics: {
          manifest: path,
          added: diff.added.length,
          removed: diff.removed.length,
          majorBumps: diff.bumped.length,
          addedNames: diff.added.slice(0, MAX_NAMED_IN_EVENT).join(', ') || null,
          removedNames: diff.removed.slice(0, MAX_NAMED_IN_EVENT).join(', ') || null,
          bumpedNames:
            diff.bumped
              .slice(0, MAX_NAMED_IN_EVENT)
              .map((bump) => `${bump.name} ${bump.from}→${bump.to}`)
              .join(', ') || null,
          scope: 'watchlist',
        },
        supersedes: null,
      });
    } catch (error) {
      if (error instanceof BudgetExhaustedError || error instanceof SecondaryRateLimitError) {
        stoppedEarly = true;
        errors.push(`manifests: ${error.message}`);
        break;
      }
      errors.push(`manifests ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      if (before) rows.push(before);
    }
  }

  return { rows, events, errors, stoppedEarly, unsupported };
}
