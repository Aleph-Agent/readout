import type { AssertExhaustive } from './keys.ts';

export type JobKind = 'pulse' | 'daily' | 'weekly';

/**
 * `data/meta.json` — the run ledger, rewritten every run.
 *
 * This file exists so staleness is visible rather than hidden. GitHub does not
 * notify on workflow failure and scheduled runs are routinely delayed 10–30
 * minutes at peak, so the site must render the actual last-run timestamp and
 * never a promised one.
 *
 * It is also where every per-run timestamp lives, keeping that churn out of
 * `live/state.jsonl`.
 */
export interface MetaRecord {
  /** ISO 8601 UTC the run started, successful or not. */
  lastRunAt: string | null;
  /** ISO 8601 UTC of the last run that completed without a fatal error. */
  lastSuccessfulRunAt: string | null;
  job: JobKind | null;
  /** True when the run stopped early — low rate limit, or a collector failed. */
  partial: boolean;
  /** REST calls actually spent. 304s do not count against the budget. */
  requestsConsumed: number;
  /** `X-RateLimit-Remaining` at the end of the run. Below 500, stop cleanly. */
  rateLimitRemaining: number | null;
  reposChecked: number;
  /**
   * Conditional requests answered 304. High is good: it means ETags are
   * working and most of the watchlist cost nothing this run.
   *
   * Counts requests, not repositories — a pulse makes two per repository, so
   * this can legitimately reach twice `reposChecked`.
   */
  requestsUnchanged: number;
  eventsDetected: number;
  /** Collector names that threw. One failing must not abort the others. */
  collectorsErrored: string[];
  summariesGenerated: number;
  /**
   * Share of summary attempts that returned the literal string INSUFFICIENT.
   * Null before any attempt. Above roughly 0.25 the significance thresholds are
   * too loose and should be tightened, not the prompt loosened.
   */
  insufficientRate: number | null;
  /** Hash of the emitted static bundle. Drives the deploy gate. */
  bundleHash: string | null;
  /** True when the bundle matched the previous run and deployment was skipped. */
  deploySkipped: boolean | null;
}

export const META_KEYS = [
  'lastRunAt',
  'lastSuccessfulRunAt',
  'job',
  'partial',
  'requestsConsumed',
  'rateLimitRemaining',
  'reposChecked',
  'requestsUnchanged',
  'eventsDetected',
  'collectorsErrored',
  'summariesGenerated',
  'insufficientRate',
  'bundleHash',
  'deploySkipped',
] as const satisfies readonly (keyof MetaRecord)[];

export type _MetaKeysExhaustive = AssertExhaustive<
  Exclude<keyof MetaRecord, (typeof META_KEYS)[number]>
>;

/** The honest zero state: collected nothing, claims nothing. */
export const EMPTY_META: MetaRecord = {
  lastRunAt: null,
  lastSuccessfulRunAt: null,
  job: null,
  partial: false,
  requestsConsumed: 0,
  rateLimitRemaining: null,
  reposChecked: 0,
  requestsUnchanged: 0,
  eventsDetected: 0,
  collectorsErrored: [],
  summariesGenerated: 0,
  insufficientRate: null,
  bundleHash: null,
  deploySkipped: null,
};
