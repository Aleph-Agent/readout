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
const LIVE_DIR = join(DATA_DIR, 'live');
export const HISTORY_DIR = join(DATA_DIR, 'history');
export const EVENTS_DIR = join(DATA_DIR, 'events');

export const WATCHLIST_PATH = join(DATA_DIR, 'watchlist.jsonl');

/** Base models whose descendants are traced. Curated, like the watchlist. */
export const LINEAGE_ROOTS_PATH = join(DATA_DIR, 'lineage-roots.jsonl');
export const LIVE_STATE_PATH = join(LIVE_DIR, 'state.jsonl');
export const WINDOW_PATH = join(LIVE_DIR, 'window.jsonl');

/** Last-seen dependency set per repository, so the next run can diff it. */
export const MANIFESTS_PATH = join(LIVE_DIR, 'manifests.jsonl');

/**
 * Download and install counts per package, with a bounded trend.
 *
 * Lives under `live/` rather than as an append-only ledger because it carries
 * its own history inline: one row per package holding the last few weeks of
 * readings. Appending at this grain would add a megabyte of git a month to
 * answer a question that never looks back further than that.
 */
export const ADOPTION_PATH = join(LIVE_DIR, 'adoption.jsonl');

/**
 * Other people's assessment of a watched project: the OpenSSF Scorecard and
 * the advisories filed against what it publishes. Overwritten daily — these
 * are current states, not events, and the history that matters is the score
 * moving rather than every day it did not.
 */
export const HEALTH_PATH = join(LIVE_DIR, 'health.jsonl');
export const META_PATH = join(DATA_DIR, 'meta.json');

/**
 * Generated prose, keyed by event id. Separate from the events themselves
 * because those are append-only and never rewritten, and because measurement
 * and interpretation are different things that should stay visibly apart.
 */
export const SUMMARIES_PATH = join(DATA_DIR, 'summaries.jsonl');

/** What has been announced publicly. Exists to make double-posting impossible. */
export const ANNOUNCEMENTS_PATH = join(DATA_DIR, 'announcements.jsonl');

/**
 * How close everything got to each threshold, once a day.
 *
 * Append-only like the events, and for the same reason: it is the record of
 * whether this instrument was ever able to see what it claims to look for, and
 * a record that can be rewritten proves nothing.
 */
export const CALIBRATION_PATH = join(DATA_DIR, 'calibration.jsonl');

/**
 * Static output root. Everything the site serves is written here and nowhere
 * else. Never committed — it is rebuilt from the ledger on every run.
 */
export const DIST_DIR = process.env['SIGNAL_DIST_DIR'] ?? join(ROOT, 'dist');
export const DIST_DATA_DIR = join(DIST_DIR, 'data');

/**
 * A repository id becomes a file path — `dist/repo/{owner}/{name}.html` — so it
 * has to be validated as one, not just as a plausible-looking string.
 *
 * The naive `owner/name` shape accepts `../..`, because `..` is a run of legal
 * name characters and there is exactly one slash. That would write outside the
 * output directory. The watchlist is committed and reviewed, so this is a guard
 * against a mistake rather than an attacker, but it costs nothing and the
 * failure it prevents is silent.
 *
 * Leading dots are allowed: `.github/.github` is a real repository. Segments
 * that are *only* dots are not.
 */
function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 100 &&
    /^[A-Za-z0-9._-]+$/.test(segment) &&
    !/^\.+$/.test(segment)
  );
}

export function isSafeRepoId(id: string): boolean {
  const parts = id.split('/');
  return parts.length === 2 && parts.every((part) => isSafeSegment(part));
}

export function assertSafeRepoId(id: string): string {
  if (!isSafeRepoId(id)) {
    throw new Error(`unsafe repository id ${JSON.stringify(id)}: expected owner/name`);
  }
  return id;
}

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
