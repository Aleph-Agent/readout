import {
  appendJsonl,
  conform,
  readJson,
  readJsonl,
  writeJson,
  writeJsonl,
} from './jsonl.ts';
import { existsSync, readdirSync } from 'node:fs';

import {
  ANNOUNCEMENTS_PATH,
  EVENTS_DIR,
  eventsPath,
  historyPath,
  LINEAGE_ROOTS_PATH,
  LIVE_STATE_PATH,
  MANIFESTS_PATH,
  META_PATH,
  SUMMARIES_PATH,
  WATCHLIST_PATH,
  WINDOW_PATH,
  CALIBRATION_PATH,
  ADOPTION_PATH,
} from './paths.ts';
import { CALIBRATION_KEYS, type CalibrationRow } from './calibration.ts';
import { ADOPTION_KEYS, type AdoptionRow } from '../types/adoption.ts';
import { SUMMARY_KEYS, type SummaryRecord } from '../types/summaries.ts';
import { WINDOW_KEYS, type WindowRow } from '../types/window.ts';
import { MANIFEST_KEYS, type ManifestRow } from '../types/manifests.ts';
import { ANNOUNCEMENT_KEYS, type AnnouncementRecord } from '../types/announcements.ts';
import { LINEAGE_ROOT_KEYS, type LineageRoot } from '../types/lineage.ts';
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

// ------------------------------------------------------------ lineage roots

export function readLineageRoots(): LineageRoot[] {
  return readJsonl(LINEAGE_ROOTS_PATH).map((row) =>
    conform<LineageRoot>(row, LINEAGE_ROOT_KEYS),
  );
}

export function writeLineageRoots(rows: readonly LineageRoot[]): void {
  writeJsonl(LINEAGE_ROOTS_PATH, rows, LINEAGE_ROOT_KEYS, {
    sortBy: (row) => row.id.toLowerCase(),
    rejectDuplicates: true,
  });
}

// --------------------------------------------------------------- live state

export function readLiveState(): LiveStateRow[] {
  // Conformed on the way in: the base collector carries unchanged rows forward
  // verbatim, so a key left behind by a schema change would ride along into the
  // next write and fail the key-order guard.
  return readJsonl(LIVE_STATE_PATH).map((row) => conform<LiveStateRow>(row, LIVE_STATE_KEYS));
}

/** Overwritten every pulse. Sorted by repository id, duplicates rejected. */
export function writeLiveState(rows: readonly LiveStateRow[]): void {
  writeJsonl(LIVE_STATE_PATH, rows, LIVE_STATE_KEYS, {
    sortBy: repoSortKey,
    rejectDuplicates: true,
  });
}

// ---------------------------------------------------- rolling sample window

export function readWindow(): WindowRow[] {
  return readJsonl(WINDOW_PATH).map((row) => conform<WindowRow>(row, WINDOW_KEYS));
}

/** Sorted by repository id, duplicates rejected — same discipline as state. */
export function writeWindow(rows: readonly WindowRow[]): void {
  writeJsonl(WINDOW_PATH, rows, WINDOW_KEYS, {
    sortBy: repoSortKey,
    rejectDuplicates: true,
  });
}

// ------------------------------------------------------------------- adoption

export function readAdoption(): AdoptionRow[] {
  return readJsonl(ADOPTION_PATH).map((row) => conform<AdoptionRow>(row, ADOPTION_KEYS));
}

/**
 * Sorted by repository, then registry, then package name.
 *
 * Three keys because one repository can publish several packages to several
 * registries, and a stable order across all three is what keeps the daily diff
 * to the counts that actually moved.
 */
export function writeAdoption(rows: readonly AdoptionRow[]): void {
  writeJsonl(ADOPTION_PATH, rows, ADOPTION_KEYS, {
    sortBy: (row) => [repoSortKey(row), row.registry, row.name].join(' '),
    rejectDuplicates: true,
  });
}

// ------------------------------------------------------------------ manifests

export function readManifests(): ManifestRow[] {
  return readJsonl(MANIFESTS_PATH).map((row) => conform<ManifestRow>(row, MANIFEST_KEYS));
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

// -------------------------------------------------------------- calibration

export function readCalibration(): CalibrationRow[] {
  return readJsonl(CALIBRATION_PATH).map((row) =>
    conform<CalibrationRow>(row, CALIBRATION_KEYS),
  );
}

/**
 * Append one day's calibration rows.
 *
 * Idempotent per day and per collector, so a re-run repairs nothing and
 * duplicates nothing. Appending rather than rewriting is the point: this file
 * is the evidence that the thresholds were or were not reachable on a given
 * day, and evidence that can be edited afterwards is not evidence.
 */
export function appendCalibration(rows: readonly CalibrationRow[]): void {
  if (rows.length === 0) return;

  const existing = readCalibration();
  const seen = new Set(existing.map((row) => `${row.date}:${row.collector}:${row.metric}`));
  const fresh = rows.filter((row) => !seen.has(`${row.date}:${row.collector}:${row.metric}`));
  if (fresh.length === 0) return;

  appendJsonl(CALIBRATION_PATH, fresh, CALIBRATION_KEYS);
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
  return readJsonl(SUMMARIES_PATH).map((row) => conform<SummaryRecord>(row, SUMMARY_KEYS));
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

// ------------------------------------------------------------ announcements

export function readAnnouncements(): AnnouncementRecord[] {
  return readJsonl(ANNOUNCEMENTS_PATH).map((row) =>
    conform<AnnouncementRecord>(row, ANNOUNCEMENT_KEYS),
  );
}

export function writeAnnouncements(rows: readonly AnnouncementRecord[]): void {
  writeJsonl(ANNOUNCEMENTS_PATH, rows, ANNOUNCEMENT_KEYS, {
    sortBy: (row) => row.eventId,
    rejectDuplicates: true,
  });
}

// --------------------------------------------------------------------- meta

/** Never null: a project that has not run yet still has an honest zero state. */
export function readMeta(): MetaRecord {
  const raw = readJson<Record<string, unknown>>(META_PATH);
  if (raw === null) return { ...EMPTY_META };

  // Start from the defaults, then take only declared keys that the file
  // actually has. A field the file predates keeps its default; a field the
  // schema no longer declares is dropped rather than carried into the next
  // write, where the key-order guard would reject it.
  const meta = { ...EMPTY_META } as Record<string, unknown>;
  for (const key of META_KEYS) {
    if (raw[key] !== undefined) meta[key] = raw[key];
  }
  return meta as unknown as MetaRecord;
}

export function writeMeta(meta: MetaRecord): void {
  writeJson(META_PATH, meta, META_KEYS);
}
