import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { EventRecord } from '../src/types/events.ts';
import type { HistorySnapshotRow } from '../src/types/history.ts';
import type { LiveStateRow } from '../src/types/state.ts';
import type { WatchlistEntry } from '../src/types/watchlist.ts';

// `SIGNAL_DATA_DIR` must be set before the path module is evaluated, so the
// modules under test are pulled in dynamically rather than statically. Type-only
// imports above are erased and never trigger evaluation.
const dataDir = mkdtempSync(join(tmpdir(), 'signal-ledger-'));
process.env['SIGNAL_DATA_DIR'] = dataDir;

const ledger = await import('../src/lib/ledger.ts');
const paths = await import('../src/lib/paths.ts');

beforeEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env['SIGNAL_DATA_DIR'];
});

function entry(id: string): WatchlistEntry {
  return { id, category: 'devtool', added: '2026-08-04', active: true, packages: [] };
}

function stateRow(id: string, forks: number, etag: string | null = null): LiveStateRow {
  return {
    id,
    fullName: id,
    active: true,
    forks,
    stars: forks * 10,
    openIssues: 4,
    language: null,
    pushedAt: '2026-08-04T00:00:00Z',
    latestReleaseTag: null,
    latestReleaseAt: null,
    etag,
    releaseEtag: null,
  };
}

function event(id: string, kind: EventRecord['kind'] = 'release'): EventRecord {
  return {
    id,
    kind,
    repo: 'owner/repo',
    detectedAt: '2026-08-04T02:17:00Z',
    confidence: 'detected',
    summaryState: 'pending',
    summary: null,
    summarySource: null,
    evidenceUrl: 'https://github.com/owner/repo/releases/tag/v1.0.0',
    metrics: { forks: 12, baseline: 3 },
    supersedes: null,
  };
}

describe('watchlist', () => {
  it('round trips', () => {
    const entries = [entry('b/two'), entry('a/one')];
    ledger.writeWatchlist(entries);
    expect(ledger.readWatchlist()).toEqual([entry('a/one'), entry('b/two')]);
  });

  it('sorts case-insensitively, so capitalised owners are not banished to the top', () => {
    ledger.writeWatchlist([entry('zed-industries/zed'), entry('BurntSushi/ripgrep'), entry('apache/spark')]);
    expect(ledger.readWatchlist().map((e) => e.id)).toEqual([
      'apache/spark',
      'BurntSushi/ripgrep',
      'zed-industries/zed',
    ]);
  });

  it('rejects a duplicate that differs only in case, because GitHub treats them as one repo', () => {
    expect(() => ledger.writeWatchlist([entry('Foo/Bar'), entry('foo/bar')])).toThrow(
      /duplicate sort key "foo\/bar"/,
    );
  });

  it('filters inactive entries without deleting them', () => {
    ledger.writeWatchlist([entry('a/one'), { ...entry('b/two'), active: false }]);
    expect(ledger.readWatchlist()).toHaveLength(2);
    expect(ledger.readActiveWatchlist().map((e) => e.id)).toEqual(['a/one']);
  });
});

describe('live state', () => {
  it('writes byte-identical output for the same data', () => {
    const rows = [stateRow('b/two', 5), stateRow('a/one', 3)];

    ledger.writeLiveState(rows);
    const first = readFileSync(paths.LIVE_STATE_PATH);

    ledger.writeLiveState([...rows].reverse());
    const second = readFileSync(paths.LIVE_STATE_PATH);

    expect(second.equals(first)).toBe(true);
  });

  it('changes exactly one line when exactly one repository changes', () => {
    // The whole point of the sorted / fixed-key layout: an unchanged repository
    // must contribute no delta, or git stores six full copies a day.
    ledger.writeLiveState([stateRow('a/one', 3), stateRow('b/two', 5)]);
    const before = readFileSync(paths.LIVE_STATE_PATH, 'utf8').split('\n');

    ledger.writeLiveState([stateRow('a/one', 3), stateRow('b/two', 6)]);
    const after = readFileSync(paths.LIVE_STATE_PATH, 'utf8').split('\n');

    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it('round trips the ETag the next run replays as If-None-Match', () => {
    ledger.writeLiveState([stateRow('a/one', 3, 'W/"abc"'), stateRow('b/two', 5, null)]);
    const rows = new Map(ledger.readLiveState().map((row) => [row.id, row]));

    expect(rows.get('a/one')?.etag).toBe('W/"abc"');
    expect(rows.get('b/two')?.etag).toBeNull();
  });
});

describe('history', () => {
  const row = (id: string, date: string): HistorySnapshotRow => ({
    id,
    date,
    forks: 10,
    stars: 100,
    openIssues: 2,
  });

  it('round trips a snapshot', () => {
    ledger.writeSnapshot('2026-08-04', [row('b/two', '2026-08-04'), row('a/one', '2026-08-04')]);
    expect(ledger.readSnapshot('2026-08-04').map((r) => r.id)).toEqual(['a/one', 'b/two']);
  });

  it('refuses to rewrite a day that already exists', () => {
    ledger.writeSnapshot('2026-08-04', [row('a/one', '2026-08-04')]);
    expect(() => ledger.writeSnapshot('2026-08-04', [row('a/one', '2026-08-04')])).toThrow(
      /History is immutable/,
    );
  });

  it('allows an explicit repair', () => {
    ledger.writeSnapshot('2026-08-04', [row('a/one', '2026-08-04')]);
    ledger.writeSnapshot('2026-08-04', [row('a/one', '2026-08-04'), row('b/two', '2026-08-04')], {
      overwrite: true,
    });
    expect(ledger.readSnapshot('2026-08-04')).toHaveLength(2);
  });

  it('rejects a row dated differently from its file', () => {
    expect(() => ledger.writeSnapshot('2026-08-04', [row('a/one', '2026-08-03')])).toThrow(
      /is dated 2026-08-03, not 2026-08-04/,
    );
  });

  it('rejects a malformed date rather than inventing a filename', () => {
    expect(() => ledger.readSnapshot('2026-8-4')).toThrow(/expected YYYY-MM-DD/);
  });
});

describe('events', () => {
  it('appends without disturbing a single existing byte', () => {
    ledger.appendEvents('2026-08', [event('release:owner/repo:v1.0.0')]);
    const before = readFileSync(paths.eventsPath('2026-08'));

    ledger.appendEvents('2026-08', [event('release:owner/repo:v1.1.0')]);
    const after = readFileSync(paths.eventsPath('2026-08'));

    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(ledger.readEvents('2026-08')).toHaveLength(2);
  });

  it('keeps chronological order rather than sorting', () => {
    ledger.appendEvents('2026-08', [event('z-later'), event('a-earlier')]);
    expect(ledger.readEvents('2026-08').map((e) => e.id)).toEqual(['z-later', 'a-earlier']);
  });

  it('rejects an id already on disk, so a re-detection cannot duplicate', () => {
    ledger.appendEvents('2026-08', [event('release:owner/repo:v1.0.0')]);
    expect(() => ledger.appendEvents('2026-08', [event('release:owner/repo:v1.0.0')])).toThrow(
      /Append a correction instead/,
    );
  });

  it('rejects a duplicate inside a single batch', () => {
    expect(() => ledger.appendEvents('2026-08', [event('same'), event('same')])).toThrow(
      /already exists/,
    );
  });

  it('records a correction as a new event pointing at the old one', () => {
    const original = event('fork-spike:owner/repo:2026-08-04', 'fork-spike');
    const correction: EventRecord = {
      ...event('correction:owner/repo:2026-08-05', 'correction'),
      supersedes: original.id,
    };

    ledger.appendEvents('2026-08', [original]);
    ledger.appendEvents('2026-08', [correction]);

    const stored = ledger.readEvents('2026-08');
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual(original);
    expect(stored[1]?.supersedes).toBe(original.id);
  });
});

describe('eventId', () => {
  it('is deterministic across runs', () => {
    expect(ledger.eventId('release', 'owner/repo', 'v1.0.0')).toBe(
      ledger.eventId('release', 'owner/repo', 'v1.0.0'),
    );
  });

  it('folds repository case, so one repository cannot hold two ids', () => {
    expect(ledger.eventId('release', 'Owner/Repo', 'v1.0.0')).toBe(
      ledger.eventId('release', 'owner/repo', 'v1.0.0'),
    );
  });
});

describe('meta', () => {
  it('reads an honest zero state before the first run', () => {
    const meta = ledger.readMeta();
    expect(meta.lastRunAt).toBeNull();
    expect(meta.lastSuccessfulRunAt).toBeNull();
    expect(meta.reposChecked).toBe(0);
  });

  it('round trips', () => {
    const meta = {
      ...ledger.readMeta(),
      lastRunAt: '2026-08-04T02:17:00Z',
      lastSuccessfulRunAt: '2026-08-04T02:17:00Z',
      job: 'daily' as const,
      reposChecked: 400,
      requestsUnchanged: 372,
      requestsConsumed: 28,
    };

    ledger.writeMeta(meta);
    expect(ledger.readMeta()).toEqual(meta);
  });

  it('drops a field the schema no longer declares', () => {
    // This is not hypothetical. reposUnchanged was renamed to
    // requestsUnchanged, the committed meta.json kept the old name, and the
    // first real pipeline run died spreading it into the next write.
    const path = join(dataDir, 'meta.json');
    ledger.writeMeta(ledger.readMeta());
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...raw, reposUnchanged: 372 }), 'utf8');

    const meta = ledger.readMeta();
    expect(Object.keys(meta)).not.toContain('reposUnchanged');
    expect(() => ledger.writeMeta(meta)).not.toThrow();
  });

  it('keeps the default for a field the file predates', () => {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, 'meta.json');
    writeFileSync(path, JSON.stringify({ lastRunAt: '2026-08-04T02:17:00Z' }), 'utf8');

    const meta = ledger.readMeta();
    expect(meta.lastRunAt).toBe('2026-08-04T02:17:00Z');
    expect(meta.requestsUnchanged).toBe(0);
    expect(meta.collectorsErrored).toEqual([]);
  });

  it('writes stable bytes for the same record', () => {
    const meta = ledger.readMeta();
    ledger.writeMeta(meta);
    const first = readFileSync(paths.META_PATH);
    ledger.writeMeta(meta);
    expect(readFileSync(paths.META_PATH).equals(first)).toBe(true);
  });
});
