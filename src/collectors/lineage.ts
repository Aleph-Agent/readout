import { eventId } from '../lib/ledger.ts';
import type { HuggingFaceClient } from '../lib/huggingface.ts';
import type { EventRecord } from '../types/events.ts';
import type { LineageRoot } from '../types/lineage.ts';

/**
 * Model descent.
 *
 * Which models declare a given model as the one they were built from, and how
 * many of those appeared this week. That relation is self-declared by whoever
 * uploaded the model, so the claim this supports is "N models say they were
 * built on X", never "N models were built on X". The wording keeps that
 * distinction and so does the template.
 *
 * Weekly, because descent moves at the speed of people training models.
 */

export interface LineageThresholds {
  /** New descendants required before a week is worth reporting. */
  minNew: number;
  /**
   * Distinct uploading accounts required.
   *
   * The first sample taken from this API had its three newest descendants all
   * from one account. A single uploader publishing in bulk is the lineage
   * equivalent of a fork farm, and counting it as adoption would be the same
   * mistake in a different lens.
   */
  minAccounts: number;
}

export const DEFAULT_LINEAGE_THRESHOLDS: LineageThresholds = {
  minNew: 10,
  minAccounts: 3,
};

export interface LineageCollectionResult {
  roots: LineageRoot[];
  events: EventRecord[];
  errors: string[];
  /**
   * New descendants per root this week, crossing the bar or not.
   *
   * Kept so `minNew` can be measured against what actually arrives. A quarter
   * where no root ever gained more than two models is a quarter this detector
   * could not have fired, and that is a fact about the threshold rather than
   * about model lineage. First reads are excluded: they set a watermark and
   * gain nothing by definition.
   */
  observations: number[];
}

export interface LineageCollectionOptions {
  now: string;
  /** `YYYY-MM-DD` UTC of this run. */
  today: string;
  seen: ReadonlySet<string>;
  thresholds?: LineageThresholds;
}

function accountOf(modelId: string): string {
  return modelId.split('/')[0] ?? modelId;
}

export async function collectLineage(
  client: HuggingFaceClient,
  roots: readonly LineageRoot[],
  options: LineageCollectionOptions,
): Promise<LineageCollectionResult> {
  const thresholds = options.thresholds ?? DEFAULT_LINEAGE_THRESHOLDS;
  const updated: LineageRoot[] = [];
  const events: EventRecord[] = [];
  const errors: string[] = [];
  const observations: number[] = [];

  for (const root of roots) {
    if (!root.active) {
      updated.push(root);
      continue;
    }

    const firstRead = root.seenThrough === null;

    let descendants;
    try {
      // A first read only needs the newest record to set the mark. Pulling
      // three hundred would spend the requests to count models that existed
      // before anybody was watching, which is not what the counter means.
      descendants = await client.descendantsSince(root.id, root.seenThrough, firstRead ? 1 : 300);
    } catch (error) {
      errors.push(`lineage ${root.id}: ${error instanceof Error ? error.message : String(error)}`);
      updated.push(root);
      continue;
    }

    const newest = descendants
      .map((d) => d.createdAt)
      .filter((at): at is string => at !== null)
      .sort()
      .at(-1);

    const next: LineageRoot = {
      ...root,
      seenThrough: newest ?? root.seenThrough,
      // Nothing was gained on a first read: those models existed before anybody
      // was watching, and counting them would make the total say something it
      // does not mean.
      descendants: firstRead ? 0 : root.descendants + descendants.length,
    };
    updated.push(next);

    // First read establishes the mark. Reporting here would announce every
    // model ever built on this root as though it happened this week.
    if (firstRead) continue;

    // Recorded before the bar, because the readings that do not become events
    // are the only evidence about where the bar should be.
    observations.push(descendants.length);

    if (descendants.length < thresholds.minNew) continue;

    const accounts = new Set(descendants.map((d) => accountOf(d.id)));
    if (accounts.size < thresholds.minAccounts) continue;

    const id = eventId('lineage', root.id, options.today);
    if (options.seen.has(id)) continue;

    const busiest = [...descendants].sort((a, b) => b.downloads - a.downloads)[0];

    events.push({
      id,
      kind: 'lineage',
      // Keyed to the watchlist repository where there is one, so the finding
      // lands on a profile page a reader can already navigate to.
      repo: root.repo ?? root.id,
      detectedAt: options.now,
      // Read straight off an endpoint, with a link. A fact, not an inference.
      confidence: 'confirmed',
      summaryState: 'pending',
      summary: null,
      summarySource: null,
      evidenceUrl: `https://huggingface.co/models?other=base_model:${encodeURIComponent(root.id)}`,
      metrics: {
        baseModel: root.id,
        newDescendants: descendants.length,
        uploaders: accounts.size,
        totalSinceWatching: next.descendants,
        mostDownloaded: busiest?.id ?? null,
        scope: 'self-declared',
      },
      supersedes: null,
    });
  }

  return { roots: updated, events, errors, observations };
}
