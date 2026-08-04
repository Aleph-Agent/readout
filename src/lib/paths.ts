import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Repository root, resolved from this module rather than `process.cwd()`. */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Ledger root. Defaults to `<repo>/data`.
 *
 * `SIGNAL_DATA_DIR` redirects it, which is how tests exercise the real write
 * helpers without touching the committed ledger, and how Prompt 2's dry run
 * will collect against a scratch directory before it is trusted with the real
 * one. Unset in CI and in production.
 */
export const DATA_DIR = process.env['SIGNAL_DATA_DIR'] ?? join(ROOT, 'data');
export const LIVE_DIR = join(DATA_DIR, 'live');
export const HISTORY_DIR = join(DATA_DIR, 'history');
export const EVENTS_DIR = join(DATA_DIR, 'events');

export const WATCHLIST_PATH = join(DATA_DIR, 'watchlist.jsonl');
export const LIVE_STATE_PATH = join(LIVE_DIR, 'state.jsonl');
export const WINDOW_PATH = join(LIVE_DIR, 'window.jsonl');

/** Last-seen dependency set per repository, so the next run can diff it. */
export const MANIFESTS_PATH = join(LIVE_DIR, 'manifests.jsonl');
export const META_PATH = join(DATA_DIR, 'meta.json');

/**
 * Generated prose, keyed by event id. Separate from the events themselves
 * because those are append-only and never rewritten, and because measurement
 * and interpretation are different things that should stay visibly apart.
 */
export const SUMMARIES_PATH = join(DATA_DIR, 'summaries.jsonl');

/**
 * Static output root. Everything the site serves is written here and nowhere
 * else. Never committed — it is rebuilt from the ledger on every run.
 */
export const DIST_DIR = process.env['SIGNAL_DIST_DIR'] ?? join(ROOT, 'dist');
export const DIST_DATA_DIR = join(DIST_DIR, 'data');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

/** `data/history/YYYY-MM-DD.jsonl`. Rejects anything that is not a bare date. */
export function historyPath(date: string): string {
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`historyPath: expected YYYY-MM-DD, got "${date}"`);
  }
  return join(HISTORY_DIR, `${date}.jsonl`);
}

/** `data/events/YYYY-MM.jsonl`. Rejects anything that is not a bare month. */
export function eventsPath(month: string): string {
  if (!MONTH_PATTERN.test(month)) {
    throw new Error(`eventsPath: expected YYYY-MM, got "${month}"`);
  }
  return join(EVENTS_DIR, `${month}.jsonl`);
}

/** `YYYY-MM-DD` in UTC. Local time would shift the snapshot date by timezone. */
export function utcDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** `YYYY-MM` in UTC. */
export function utcMonth(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}
