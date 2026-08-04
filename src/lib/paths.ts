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
export const META_PATH = join(DATA_DIR, 'meta.json');

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
