/**
 * The end-of-life clock.
 *
 * Runtimes and databases stop receiving security fixes on published dates that
 * nobody watches. A team learns Python 3.9 went unsupported when an auditor
 * tells them, not when it happened — and the date was public for years.
 *
 * endoflife.date publishes 462 products as free unauthenticated JSON, one
 * request each. Nothing here is inferred: the dates are theirs, cited, and a
 * cycle with no announced date is reported as unannounced rather than guessed.
 *
 * The list of products is curated for the same reason the watchlist is. Pulling
 * all 462 would spend 462 requests to report on COBOL compilers; these are the
 * ones the watched repositories actually run on.
 */

import type { EventRecord } from '../types/events.ts';
import type { LifecycleRow } from '../types/lifecycle.ts';
import { eventId } from '../lib/ledger.ts';
import { sleep } from '../lib/registries.ts';

const USER_AGENT = 'readout-agent (+https://github.com/kaitzyy-dev/readout)';

/**
 * Curated, like the watchlist, and for the same reason.
 *
 * These are the runtimes, databases and platforms the watched repositories are
 * written in or deployed on. A product nobody here runs on is a request spent
 * to report a date to nobody.
 */
export const TRACKED = [
  'nodejs',
  'python',
  'go',
  'rust',
  'ruby',
  'php',
  // There is no `java` product. The dates people mean by "Java 17 is supported
  // until 2029" are Oracle's JDK dates, so that is the one tracked.
  'oracle-jdk',
  'dotnet',
  'postgresql',
  'mysql',
  'mongodb',
  'redis',
  'elasticsearch',
  'kubernetes',
  'docker-engine',
  'terraform',
  'django',
  'rails',
  'laravel',
  'spring-framework',
  'ubuntu',
  'debian',
  'alpine',
  'nginx',
] as const;

/** Inside this many days, an approaching date is worth saying out loud. */
export const WARN_DAYS = 90;

/** Politeness. Nothing here is urgent and it is somebody else's free service. */
export const DELAY_MS = 120;

interface Cycle {
  cycle?: unknown;
  eol?: unknown;
  latest?: unknown;
  lts?: unknown;
  releaseDate?: unknown;
}

export interface LifecycleClient {
  cycles(product: string): Promise<Cycle[] | null>;
  requests(): number;
}

export function createLifecycleClient(): LifecycleClient {
  let spent = 0;
  return {
    requests: () => spent,
    async cycles(product) {
      spent += 1;
      const response = await fetch(`https://endoflife.date/api/${product}.json`, {
        headers: { 'user-agent': USER_AGENT },
      });
      if (!response.ok) return null;
      return (await response.json()) as Cycle[];
    },
  };
}

/**
 * `eol` is a date string, or a boolean.
 *
 * `false` means supported with no announced end — a real and different state
 * from "ends on a date", and reporting it as either supported-forever or
 * already-ended would be wrong in opposite directions.
 */
function eolOf(value: unknown): { date: string | null; ended: boolean | null } {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value, ended: false };
  }
  if (value === true) return { date: null, ended: true };
  if (value === false) return { date: null, ended: false };
  return { date: null, ended: null };
}

export function daysUntil(date: string, today: string): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

export interface LifecycleCollectionResult {
  rows: LifecycleRow[];
  events: EventRecord[];
  errors: string[];
  requests: number;
}

export interface LifecycleCollectionOptions {
  now: string;
  /** `YYYY-MM-DD` UTC. */
  today: string;
  seen: ReadonlySet<string>;
  client?: LifecycleClient;
  products?: readonly string[];
  delayMs?: number;
}

export async function collectLifecycle(
  previous: readonly LifecycleRow[],
  options: LifecycleCollectionOptions,
): Promise<LifecycleCollectionResult> {
  const client = options.client ?? createLifecycleClient();
  const products = options.products ?? TRACKED;
  const errors: string[] = [];
  const events: EventRecord[] = [];
  const rows: LifecycleRow[] = [];

  const before = new Map(previous.map((row) => [`${row.product} ${row.cycle}`, row]));

  for (const [index, product] of products.entries()) {
    if (index > 0) await sleep(options.delayMs ?? DELAY_MS);

    let cycles: Cycle[] | null;
    try {
      cycles = await client.cycles(product);
    } catch (error) {
      errors.push(
        `lifecycle ${product}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Carry every cycle of this product forward untouched. A failed read must
      // not look like a product that stopped existing.
      for (const [key, row] of before) {
        if (key.startsWith(`${product} `)) rows.push(row);
      }
      continue;
    }

    if (cycles === null) {
      errors.push(`lifecycle ${product}: not found`);
      continue;
    }

    for (const entry of cycles) {
      const cycle = typeof entry.cycle === 'string' ? entry.cycle : String(entry.cycle ?? '');
      if (cycle === '') continue;

      const { date, ended } = eolOf(entry.eol);
      const remaining = date === null ? null : daysUntil(date, options.today);

      rows.push({
        product,
        cycle,
        eol: date,
        // Ended is derived from the date when there is one, so the row cannot
        // say "supported" about a date that passed last year.
        ended: remaining !== null ? remaining < 0 : (ended ?? false),
        latest: typeof entry.latest === 'string' ? entry.latest : null,
        lts: entry.lts === true,
        observedAt: options.now,
      });

      // Announced once, when it comes inside the window. Not every day after —
      // a countdown repeated ninety times is a countdown nobody reads.
      if (remaining === null || remaining < 0 || remaining > WARN_DAYS) continue;

      const was = before.get(`${product} ${cycle}`);
      const wasOutside =
        was?.eol == null || daysUntil(was.eol, options.today) > WARN_DAYS;
      if (was !== undefined && !wasOutside) continue;

      const id = eventId('eol-approaching', `${product}/${cycle}`, options.today);
      if (options.seen.has(id)) continue;

      events.push({
        id,
        kind: 'eol-approaching',
        repo: `${product}/${cycle}`,
        detectedAt: options.now,
        confidence: 'confirmed',
        summaryState: 'skipped',
        summary: null,
        summarySource: null,
        evidenceUrl: `https://endoflife.date/${product}`,
        metrics: { product, cycle, eol: date, daysRemaining: remaining },
        supersedes: null,
      });
    }
  }

  return { rows, events, errors, requests: client.requests() };
}
