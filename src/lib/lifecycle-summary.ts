import type { LifecycleRow } from '../types/lifecycle.ts';
import { daysUntil } from '../collectors/lifecycle.ts';

/**
 * The end-of-life clock, summarised for a page.
 *
 * Two questions and no more. "When does the thing I am running stop getting
 * security fixes", and "what do I move to". Everything else endoflife.date
 * publishes is a detail nobody acts on, and a table of 462 products with 26
 * cycles each answers neither question — it buries them.
 */

export interface LifecycleReading {
  product: string;
  cycle: string;
  /** Published end date. Never inferred; rows without one are excluded. */
  eol: string;
  /** Days from the run date. Negative means it already passed. */
  days: number;
  latest: string | null;
  lts: boolean;
}

/** What is still getting fixes, newest cycle first. The "move to" answer. */
export interface SupportedProduct {
  product: string;
  cycles: string[];
  /** Newest release of the newest supported cycle, where one is published. */
  latest: string | null;
}

export interface LifecycleSummary {
  /** Products with at least one cycle on record. */
  products: number;
  /** Cycles carrying a published end date. */
  dated: number;
  /** Cycles whose date has passed. */
  ended: number;
  /** Cycles ending within `HORIZON_DAYS`. */
  approaching: number;
  /** Soonest first, ending cycles only. Bounded — see `SOON_LIMIT`. */
  soon: LifecycleReading[];
  supported: SupportedProduct[];
}

/** How far ahead the page looks. A year is roughly one planning cycle. */
export const HORIZON_DAYS = 365;

/** Rows shown. Beyond this the table stops being read. */
export const SOON_LIMIT = 14;

/**
 * Cycle strings sort as versions, not as text.
 *
 * `'10'` before `'9'` is what string comparison gives, and a page that lists
 * Node 10 as the newest supported release is worse than no page.
 */
function compareCycle(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = Number.parseInt(left[i] ?? '0', 10);
    const y = Number.parseInt(right[i] ?? '0', 10);
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return y - x;
  }

  return 0;
}

export function summariseLifecycle(
  rows: readonly LifecycleRow[],
  today: string,
): LifecycleSummary {
  const products = new Set<string>();
  const soon: LifecycleReading[] = [];
  const byProduct = new Map<string, LifecycleRow[]>();

  let dated = 0;
  let ended = 0;
  let approaching = 0;

  for (const row of rows) {
    products.add(row.product);

    const list = byProduct.get(row.product);
    if (list) list.push(row);
    else byProduct.set(row.product, [row]);

    if (row.ended) ended += 1;
    if (row.eol === null) continue;

    dated += 1;
    const days = daysUntil(row.eol, today);
    if (days < 0) continue;
    if (days > HORIZON_DAYS) continue;

    approaching += 1;
    soon.push({
      product: row.product,
      cycle: row.cycle,
      eol: row.eol,
      days,
      latest: row.latest,
      lts: row.lts,
    });
  }

  soon.sort((a, b) => a.days - b.days || a.product.localeCompare(b.product));

  const supported: SupportedProduct[] = [];
  for (const [product, list] of [...byProduct.entries()].sort()) {
    const live = list.filter((row) => !row.ended).sort((a, b) => compareCycle(a.cycle, b.cycle));
    if (live.length === 0) continue;
    supported.push({
      product,
      cycles: live.map((row) => row.cycle),
      latest: live[0]?.latest ?? null,
    });
  }

  return {
    products: products.size,
    dated,
    ended,
    approaching,
    soon: soon.slice(0, SOON_LIMIT),
    supported,
  };
}
