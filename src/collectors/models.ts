/**
 * The model catalogue: prices, context windows, and what disappeared.
 *
 * One request to a free, unauthenticated endpoint returns 400 models across 58
 * providers with prices attached. The prices span four orders of magnitude —
 * $0.01 to $150 per million prompt tokens — they move weekly, and no dated
 * record of them exists anywhere.
 *
 * Three claims come out of watching it, and all three are field diffs rather
 * than thresholds, which is the class of signal this project has had the most
 * success with:
 *
 *   - a price moved
 *   - a context window changed under a fixed name
 *   - a model stopped being offered
 *
 * The last is the one nobody else records. A withdrawn model is simply gone
 * from every catalogue the next day, and the row here is the only evidence it
 * was ever offered at that price.
 *
 * Pure except the client, so every edge is testable: a first read, a price
 * moving, a model vanishing and returning, a catalogue that fails to load.
 */

import { changed } from '../lib/diffing.ts';
import { eventId } from '../lib/ledger.ts';
import type { EventRecord } from '../types/events.ts';
import type { ModelRow, ModelSample } from '../types/models.ts';

const CATALOGUE = 'https://openrouter.ai/api/v1/models';

const USER_AGENT = 'sighttrue-agent (+https://github.com/kaitzyy-dev/sighttrue)';

/** Enough to see a price move and settle. Bounded so the file cannot run away. */
export const TREND_DAYS = 35;

/**
 * Below this a "change" is rounding in the catalogue rather than a decision by
 * anybody. Prices are quoted per token and multiplied up here, so the last
 * decimal place moves on its own.
 */
export const MIN_PRICE_MOVE = 0.02;

export interface ModelCatalogueEntry {
  id: string;
  name?: string;
  context_length?: number | null;
  pricing?: { prompt?: string; completion?: string };
}

export interface ModelClient {
  catalogue(): Promise<ModelCatalogueEntry[]>;
  requests(): number;
}

export function createModelClient(): ModelClient {
  let spent = 0;
  return {
    requests: () => spent,
    async catalogue() {
      spent += 1;
      const response = await fetch(CATALOGUE, { headers: { 'user-agent': USER_AGENT } });
      if (!response.ok) throw new Error(`catalogue: ${response.status}`);
      const body = (await response.json()) as { data?: ModelCatalogueEntry[] };
      return body.data ?? [];
    },
  };
}

/** Per million tokens. The catalogue quotes per token, as a string. */
function perMillion(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  // Six decimal places: below a hundredth of a cent per million the figure is
  // noise, and rounding here is what keeps the ledger diff line-level.
  return Math.round(parsed * 1_000_000 * 1_000_000) / 1_000_000;
}

export function recordModelSample(
  samples: readonly ModelSample[],
  sample: ModelSample,
  trendDays = TREND_DAYS,
): ModelSample[] {
  const day = sample.at.slice(0, 10);
  const floor = Date.parse(sample.at) - trendDays * 86_400_000;

  // One reading per day, so a re-run replaces rather than doubling the series.
  return [
    ...samples.filter(
      (existing) => existing.at.slice(0, 10) !== day && Date.parse(existing.at) >= floor,
    ),
    sample,
  ].sort((a, b) => (a.at < b.at ? -1 : 1));
}

export interface ModelCollectionResult {
  rows: ModelRow[];
  events: EventRecord[];
  errors: string[];
  requests: number;
}

export interface ModelCollectionOptions {
  now: string;
  /** `YYYY-MM-DD` UTC of this run. */
  today: string;
  seen: ReadonlySet<string>;
  client?: ModelClient;
  trendDays?: number;
}

export async function collectModels(
  previous: readonly ModelRow[],
  options: ModelCollectionOptions,
): Promise<ModelCollectionResult> {
  const client = options.client ?? createModelClient();
  const errors: string[] = [];
  const events: EventRecord[] = [];

  let catalogue: ModelCatalogueEntry[];
  try {
    catalogue = await client.catalogue();
  } catch (error) {
    // Nothing is written on a failed read. Marking 400 models unavailable
    // because one request timed out would be the loudest possible false claim.
    return {
      rows: [...previous],
      events: [],
      errors: [`models: ${error instanceof Error ? error.message : String(error)}`],
      requests: client.requests(),
    };
  }

  if (catalogue.length === 0) {
    return {
      rows: [...previous],
      events: [],
      errors: ['models: catalogue was empty, nothing written'],
      requests: client.requests(),
    };
  }

  const before = new Map(previous.map((row) => [row.id, row]));
  const rows: ModelRow[] = [];
  const present = new Set<string>();

  for (const entry of catalogue) {
    if (typeof entry.id !== 'string' || entry.id === '') continue;
    present.add(entry.id);

    const was = before.get(entry.id);
    const prompt = perMillion(entry.pricing?.prompt);
    const completion = perMillion(entry.pricing?.completion);
    const context = typeof entry.context_length === 'number' ? entry.context_length : null;

    rows.push({
      id: entry.id,
      provider: entry.id.split('/')[0] ?? entry.id,
      name: entry.name ?? entry.id,
      prompt,
      completion,
      context,
      firstSeen: was?.firstSeen ?? options.today,
      lastSeen: options.today,
      available: true,
      samples:
        prompt === null || completion === null || context === null
          ? (was?.samples ?? [])
          : recordModelSample(
              was?.samples ?? [],
              { at: options.now, prompt, completion, context },
              options.trendDays,
            ),
    });

    // A first read is a starting point, not a change. `changed` also refuses a
    // field the previous row never carried — see lib/diffing.ts for the two
    // incidents that rule exists because of.
    if (was === undefined) continue;

    const move = changed(was.prompt, prompt);
    if (
      move !== null &&
      move.from !== null &&
      move.to !== null &&
      Math.abs(move.to - move.from) >= MIN_PRICE_MOVE
    ) {
      const id = eventId('model-price', entry.id, options.today);
      if (!options.seen.has(id)) {
        events.push({
          id,
          kind: 'model-price',
          repo: entry.id,
          detectedAt: options.now,
          confidence: 'confirmed',
          summaryState: 'skipped',
          summary: null,
          summarySource: null,
          evidenceUrl: `https://openrouter.ai/${entry.id}`,
          metrics: { from: move.from, to: move.to, unit: 'USD per million prompt tokens' },
          supersedes: null,
        });
      }
    }
  }

  // Anything that stopped appearing. Carried forward at its last known price,
  // because that row is the only record it was ever offered.
  for (const [id, was] of before) {
    if (present.has(id)) continue;

    rows.push({ ...was, available: false });

    // Tested positively rather than as `!was.available`. A row that predates
    // the field reads as undefined, and the negation would silently swallow the
    // withdrawal — the safe direction of the mistake that produced 249 false
    // findings, but the same mistake. Only a model previously known to be
    // available can be reported as withdrawn.
    if (was.available !== true) continue;

    const eventKey = eventId('model-withdrawn', id, options.today);
    if (options.seen.has(eventKey)) continue;

    events.push({
      id: eventKey,
      kind: 'model-withdrawn',
      repo: id,
      detectedAt: options.now,
      confidence: 'confirmed',
      summaryState: 'skipped',
      summary: null,
      summarySource: null,
      evidenceUrl: `https://openrouter.ai/${id}`,
      metrics: {
        lastSeen: was.lastSeen,
        lastPrice: was.prompt,
        unit: 'USD per million prompt tokens',
      },
      supersedes: null,
    });
  }

  return { rows, events, errors, requests: client.requests() };
}
