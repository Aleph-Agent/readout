import {
  appendJsonl,
  readJson,
  readJsonl,
  writeJson,
  writeJsonl,
} from './jsonl.ts';
import { existsSync, readdirSync } from 'node:fs';

import {
  EVENTS_DIR,
  eventsPath,
  historyPath,
  LIVE_STATE_PATH,
  MANIFESTS_PATH,
  META_PATH,
  SUMMARIES_PATH,
  WATCHLIST_PATH,
  WINDOW_PATH,
} from './paths.ts';
import { SUMMARY_KEYS, type SummaryRecord } from '../types/summaries.ts';
import { WINDOW_KEYS, type WindowRow } from '../types/window.ts';
import { MANIFEST_KEYS, type ManifestRow } from '../types/manifests.ts';
import { EVENT_KEYS, type EventKind, type EventRecord } from '../types/events.ts';
import { HISTORY_KEYS, type HistorySnapshotRow } from '../types/history.ts';
import { EMPTY_META, META_KEYS, type MetaRecord } from '../types/meta.ts';
import { LIVE_STATE_KEYS, type LiveStateRow } from '../types/state.ts';
import { WATCHLIST_KEYS, type WatchlistEntry } from '../types/watchlist.ts';

/**
 * Typed access to every file in `data/`. Collectors go through here so no
 * caller has to remember which files are sorted, which are append-only, and
 * which key order belongs to which record.
 */

/**
 * Sort key for anything keyed by repository.
 *
 * Case-folded, because GitHub resolves `owner/repo` case-insensitively: `Foo/Bar`
 * and `foo/bar` are one repository, and sorting by raw code unit would both
 * separate them and put every capitalised owner ahead of every lowercase one.
 * `toLowerCase` is used rather than `toLocaleLowerCase` so the result does not
 * depend on the machine's locale.
 */
function repoSortKey(row: { id: string }): string {
  return row.id.toLowerCase();
}

// ---------------------------------------------------------------- watchlist

export function readWatchlist(): WatchlistEntry[] {
  return readJsonl<WatchlistEntry>(WATCHLIST_PATH);
}

/** Sorted by repository id, duplicates rejected. */
export function writeWatchlist(entries: readonly WatchlistEntry[]): void {
  writeJsonl(WATCHLIST_PATH, entries, WATCHLIST_KEYS, {
    sortBy: repoSortKey,
    rejectDuplicates: true,
  });
}

export function readActiveWatchlist(): WatchlistEntry[] {
  return readWatchlist().filter((entry) => entry.active);
}

// --------------------------------------------------------------- live state

export function readLiveState(): LiveStateRow[] {
  return readJsonl<LiveStateRow>(LIVE_STATE_PATH);
}

/** Overwritten every pulse. Sorted by repository id, duplicates rejected. */
export function writeLiveState(rows: readonly LiveStateRow[]): void {
  writeJsonl(LIVE_STATE_PATH, rows, LIVE_STATE_KEYS, {
    sortBy: repoSortKey,
    rejectDuplicates: true,
  });
}

/** Previous-run ETags, for replay as `If-None-Match`. */
export function readEtags(): Map<string, string> {
  const etags = new Map<string, string>();
  for (const row of readLiveState()) {
    if (row.etag !== null) etags.set(row.id, row.etag);
  }
  return etags;
}

// ---------------------------------------------------- rolling sample window

export function readWindow(): WindowRow[] {
  return readJsonl<WindowRow>(WINDOW_PATH);
}

/** Sorted by repository id, duplicates rejected — same discipline as state. */
export function writeWindow(rows: readonly WindowRow[]): void {
  writeJsonl(WINDOW_PATH, rows, WINDOW_KEYS, {
    sortBy: repoSortKey,
    rejectDuplicates: true,
  });
}

// ------------------------------------------------------------------ manifests

export function readManifests(): ManifestRow[] {
  return readJsonl<ManifestRow>(MANIFESTS_PATH);
}

export function writeManifests(rows: readonly ManifestRow[]): void {
  writeJsonl(MANIFESTS_PATH, rows, MANIFEST_KEYS, {
    sortBy: repoSortKey,
    rejectDuplicates: true,
  });
}

// ------------------------------------------------------------------ history

export function readSnapshot(date: string): HistorySnapshotRow[] {
  return readJsonl<HistorySnapshotRow>(historyPath(date));
}

/**
 * Write one daily snapshot. Immutable once written: the daily job runs once, and
 * rewriting a past day would break the audit trail that proves data was not
 * backfilled. Overwriting is therefore an explicit opt-in, not the default.
 */
export function writeSnapshot(
  date: string,
  rows: readonly HistorySnapshotRow[],
  options: { overwrite?: boolean } = {},
): void {
  const path = historyPath(date);

  if (!options.overwrite && readJsonl<HistorySnapshotRow>(path).length > 0) {
    throw new Error(
      `writeSnapshot: ${date} already exists. History is immutable; pass { overwrite: true } only to repair a run that wrote garbage.`,
    );
  }

  for (const row of rows) {
    if (row.date !== date) {
      throw new Error(`writeSnapshot: row ${row.id} is dated ${row.date}, not ${date}`);
    }
  }

  writeJsonl(path, rows, HISTORY_KEYS, {
    sortBy: repoSortKey,
    rejectDuplicates: true,
  });
}

// ------------------------------------------------------------------- events

/**
 * Deterministic event id, so re-observing the same thing on the next pulse
 * resolves to the same record instead of appending a duplicate.
 *
 * `discriminator` is whatever makes the event unique within its kind: a release
 * tag, the UTC date a spike was first seen, a dependency name.
 */
export function eventId(kind: EventKind, repo: string, discriminator: string): string {
  return `${kind}:${repo.toLowerCase()}:${discriminator}`;
}

export function readEvents(month: string): EventRecord[] {
  return readJsonl<EventRecord>(eventsPath(month));
}

/** Months with an events file, oldest first. */
export function listEventMonths(): string[] {
  if (!existsSync(EVENTS_DIR)) return [];
  return readdirSync(EVENTS_DIR)
    .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
    .map((name) => name.slice(0, 7))
    .sort();
}

/** Every event ever recorded, in chronological file order. */
export function readAllEvents(): EventRecord[] {
  return listEventMonths().flatMap((month) => readEvents(month));
}

/**
 * Append events to a month file, in caller order.
 *
 * Never sorted: the file is the chronological record, and reordering it would
 * rewrite lines that are supposed to be permanent. Duplicate ids are rejected
 * both within the batch and against what is already on disk — a wrong event is
 * superseded by a `correction`, never re-appended and never edited in place.
 */
export function appendEvents(month: string, events: readonly EventRecord[]): void {
  if (events.length === 0) return;

  const path = eventsPath(month);
  const seen = new Set(readEvents(month).map((event) => event.id));

  for (const event of events) {
    if (seen.has(event.id)) {
      throw new Error(
        `appendEvents: event "${event.id}" already exists in ${month}. Append a correction instead of rewriting.`,
      );
    }
    seen.add(event.id);
  }

  appendJsonl(path, events, EVENT_KEYS);
}

// ---------------------------------------------------------------- summaries

export function readSummaries(): SummaryRecord[] {
  return readJsonl<SummaryRecord>(SUMMARIES_PATH);
}

/**
 * Overwritten in place, sorted by event id. Unlike events this file is a
 * derived artifact, so rewriting it costs nothing in audit terms — and sorting
 * keeps its diffs line-level like everything else.
 */
export function writeSummaries(rows: readonly SummaryRecord[]): void {
  writeJsonl(SUMMARIES_PATH, rows, SUMMARY_KEYS, {
    sortBy: (row) => row.eventId,
    rejectDuplicates: true,
  });
}

/** Event ids that already have a summary outcome. Never re-summarise these. */
export function readSummarised(): Map<string, SummaryRecord> {
  return new Map(readSummaries().map((row) => [row.eventId, row]));
}

// --------------------------------------------------------------------- meta

/** Never null: a project that has not run yet still has an honest zero state. */
export function readMeta(): MetaRecord {
  return readJson<MetaRecord>(META_PATH) ?? { ...EMPTY_META };
}

export function writeMeta(meta: MetaRecord): void {
  writeJson(META_PATH, meta, META_KEYS);
}
