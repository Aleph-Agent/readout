/**
 * The model catalogue, reduced to what a page needs.
 *
 * Pure, so the one judgement here — which models are worth showing out of four
 * hundred — is testable and stated rather than emergent.
 */

import type { ModelRow } from '../types/models.ts';

const SHOWN = 12;

export interface ModelReading {
  id: string;
  provider: string;
  prompt: number;
  context: number | null;
  /** Change in USD per million against the oldest reading held. Null if one. */
  moved: number | null;
}

export interface ModelSummary {
  /** Models in the catalogue today. */
  available: number;
  /** Providers behind them. */
  providers: number;
  /** Models seen before and no longer offered. */
  withdrawn: number;
  /** Cheapest per million prompt tokens, and the most expensive. */
  cheapest: ModelReading[];
  dearest: ModelReading[];
  /** Models whose price moved within the trend window, largest move first. */
  moved: ModelReading[];
}

function reading(row: ModelRow & { prompt: number }): ModelReading {
  const first = row.samples[0];
  const last = row.samples.at(-1);

  return {
    id: row.id,
    provider: row.provider,
    prompt: row.prompt,
    context: row.context,
    // Against the oldest reading held rather than the previous one: a price
    // that drifted down over three weeks moved, and a day-on-day diff would
    // report nothing on every one of those days.
    moved:
      first === undefined || last === undefined || row.samples.length < 2
        ? null
        : Math.round((last.prompt - first.prompt) * 1_000_000) / 1_000_000,
  };
}

export function summariseModels(rows: readonly ModelRow[]): ModelSummary {
  const live = rows.filter(
    (row): row is ModelRow & { prompt: number } => row.available && row.prompt !== null,
  );

  // Free models are excluded from both ends. Zero is not the cheapest price,
  // it is a different offer — usually rate-limited, often a preview — and
  // putting it at the top of a price list would say something untrue.
  const priced = live.filter((row) => row.prompt > 0).map(reading);
  const byPrice = [...priced].sort((a, b) => a.prompt - b.prompt || (a.id < b.id ? -1 : 1));

  const moved = priced
    .filter((row): row is ModelReading & { moved: number } => row.moved !== null && row.moved !== 0)
    .sort((a, b) => Math.abs(b.moved) - Math.abs(a.moved) || (a.id < b.id ? -1 : 1))
    .slice(0, SHOWN);

  return {
    available: live.length,
    providers: new Set(rows.filter((row) => row.available).map((row) => row.provider)).size,
    withdrawn: rows.filter((row) => !row.available).length,
    cheapest: byPrice.slice(0, SHOWN),
    dearest: [...byPrice].reverse().slice(0, SHOWN),
    moved,
  };
}
