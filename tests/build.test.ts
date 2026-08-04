import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IndexBundle, LensBundle } from '../src/types/bundles.ts';
import type { EventRecord } from '../src/types/events.ts';
import type { LiveStateRow } from '../src/types/state.ts';
import type { WatchlistEntry } from '../src/types/watchlist.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'signal-build-data-'));
const distDir = mkdtempSync(join(tmpdir(), 'signal-build-dist-'));
process.env['SIGNAL_DATA_DIR'] = dataDir;
process.env['SIGNAL_DIST_DIR'] = distDir;

const ledger = await import('../src/lib/ledger.ts');
const { runBuild, recordDeploy } = await import('../src/build.ts');

const NOW = new Date('2026-08-04T12:00:00Z');
const DIST_DATA = join(distDir, 'data');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(distDir, { recursive: true, force: true });
  delete process.env['SIGNAL_DATA_DIR'];
  delete process.env['SIGNAL_DIST_DIR'];
});

function read<T>(name: string): T {
  return JSON.parse(readFileSync(join(DIST_DATA, name), 'utf8')) as T;
}

function entry(id: string): WatchlistEntry {
  return { id, category: 'devtool', added: '2026-08-04', active: true };
}

function stateRow(id: string, forks: number): LiveStateRow {
  return {
    id,
    active: true,
    forks,
    stars: forks * 10,
    openIssues: 2,
    pushedAt: '2026-08-04T00:00:00Z',
    latestReleaseTag: 'v1.0.0',
    latestReleaseAt: '2026-08-01T00:00:00Z',
    etag: null,
    releaseEtag: null,
  };
}

function releaseEvent(id: string, repo: string, detectedAt: string): EventRecord {
  return {
    id,
    kind: 'release',
    repo,
    detectedAt,
    confidence: 'confirmed',
    summaryState: 'pending',
    summary: null,
    evidenceUrl: `https://github.com/${repo}/releases/tag/v1.0.0`,
    metrics: { tag: 'v1.0.0', forks: 10 },
    supersedes: null,
  };
}

beforeAll(() => {
  ledger.writeWatchlist([entry('a/one'), entry('b/two')]);
  ledger.writeLiveState([stateRow('a/one', 10), stateRow('b/two', 20)]);
  ledger.appendEvents('2026-08', [
    releaseEvent('release:a/one:v1.0.0', 'a/one', '2026-08-04T04:17:00Z'),
    releaseEvent('release:b/two:v1.0.0', 'b/two', '2026-08-02T04:17:00Z'),
  ]);
});

describe('bundle emission', () => {
  it('emits one bundle per lens, plus an index and meta', () => {
    runBuild({ now: NOW });
    const names = readdirSync(DIST_DATA).sort();
    expect(names).toEqual([
      'demand.json',
      'forks.json',
      'index.json',
      'lineage.json',
      'meta.json',
      'ships.json',
      'stack.json',
    ]);
  });

  it('separates "no collector yet" from "nothing detected"', () => {
    // Both render as an empty list. Only the data can say which is which, and
    // conflating them would imply coverage the project does not have.
    expect(read<LensBundle>('forks.json').status).toBe('active');
    expect(read<LensBundle>('forks.json').records).toEqual([]);
    expect(read<LensBundle>('demand.json').status).toBe('pending');
    expect(read<LensBundle>('stack.json').status).toBe('pending');
    expect(read<LensBundle>('lineage.json').status).toBe('pending');
  });

  it('orders a lens newest first', () => {
    const ships = read<LensBundle>('ships.json');
    expect(ships.records.map((r) => r.repo)).toEqual(['a/one', 'b/two']);
    expect(ships.count).toBe(2);
  });

  it('carries the disclosures the site is obliged to make', () => {
    const index = read<IndexBundle>('index.json');
    expect(index.disclosure.watchlistCurated).toBe(true);
    expect(index.disclosure.cadenceHours).toBe(4);
    expect(index.disclosure.minBaselineDays).toBe(14);
  });

  it('gives the strip one mark per active repository', () => {
    const index = read<IndexBundle>('index.json');
    expect(index.strip.map((m) => m.id)).toEqual(['a/one', 'b/two']);
    // No history yet, so nothing can be classified. That is `forming`, not zero.
    expect(index.strip.every((m) => m.state === 'forming')).toBe(true);
  });

  it('lists only today in the index', () => {
    const index = read<IndexBundle>('index.json');
    expect(index.today.map((e) => e.repo)).toEqual(['a/one']);
  });

  it('reports the watchlist as curated rather than exhaustive', () => {
    const index = read<IndexBundle>('index.json');
    expect(index.watchlist).toEqual({ total: 2, active: 2, byCategory: { devtool: 2 } });
  });
});

describe('corrections', () => {
  it('replaces a superseded event rather than showing both claims', () => {
    ledger.appendEvents('2026-08', [
      {
        ...releaseEvent('correction:a/one:1', 'a/one', '2026-08-04T06:00:00Z'),
        kind: 'correction',
        supersedes: 'release:a/one:v1.0.0',
      },
    ]);

    runBuild({ now: NOW });
    const ids = read<LensBundle>('ships.json').records.map((r) => r.id);

    expect(ids).not.toContain('release:a/one:v1.0.0');
    // The ledger keeps both. Only the published view collapses them.
    expect(ledger.readEvents('2026-08')).toHaveLength(3);
  });

  it('shows the correction in the lens the original occupied', () => {
    // A correction carries kind: 'correction', which matches no lens of its
    // own. Routed by kind alone it would vanish from the site entirely — the
    // original removed and nothing in its place, which is the opposite of a
    // correction displaying with the same prominence as what it corrects.
    runBuild({ now: NOW });
    const ids = read<LensBundle>('ships.json').records.map((r) => r.id);
    expect(ids).toContain('correction:a/one:1');
  });

  it('drops a correction that points at nothing rather than guessing a lens', () => {
    ledger.appendEvents('2026-08', [
      {
        ...releaseEvent('correction:orphan', 'a/one', '2026-08-04T07:00:00Z'),
        kind: 'correction',
        supersedes: null,
      },
    ]);

    runBuild({ now: NOW });
    const everywhere = ['ships', 'forks', 'demand', 'stack', 'lineage'].flatMap((lens) =>
      read<LensBundle>(`${lens}.json`).records.map((r) => r.id),
    );
    expect(everywhere).not.toContain('correction:orphan');
  });
});

describe('deploy gate', () => {
  it('deploys the first time, because nothing has shipped yet', () => {
    expect(runBuild({ now: NOW }).deploy).toBe(true);
  });

  it('skips an immediate second run once the deployment is recorded', () => {
    const first = runBuild({ now: NOW });
    recordDeploy(first.bundleHash, true);

    const second = runBuild({ now: NOW });
    expect(second.bundleHash).toBe(first.bundleHash);
    expect(second.deploy).toBe(false);
  });

  it('ignores run telemetry, which changes every run by definition', () => {
    const before = runBuild({ now: NOW }).bundleHash;

    ledger.writeMeta({
      ...ledger.readMeta(),
      lastRunAt: '2099-01-01T00:00:00Z',
      requestsConsumed: 12_345,
      rateLimitRemaining: 42,
    });

    expect(runBuild({ now: NOW }).bundleHash).toBe(before);
  });

  it('deploys again as soon as real content changes', () => {
    ledger.appendEvents('2026-08', [
      releaseEvent('release:b/two:v2.0.0', 'b/two', '2026-08-04T10:00:00Z'),
    ]);
    expect(runBuild({ now: NOW }).deploy).toBe(true);
  });

  it('leaves the gate open when a deployment failed', () => {
    // Otherwise a bundle that never shipped is marked as shipped, and the next
    // run skips deploying it forever.
    const built = runBuild({ now: NOW });
    recordDeploy(built.bundleHash, false);
    expect(runBuild({ now: NOW }).deploy).toBe(true);
  });
});

describe('output hygiene', () => {
  it('is byte-identical for identical input', () => {
    runBuild({ now: NOW });
    const first = readFileSync(join(DIST_DATA, 'index.json'));
    runBuild({ now: NOW });
    expect(readFileSync(join(DIST_DATA, 'index.json')).equals(first)).toBe(true);
  });

  it('rebuilds from scratch so a removed bundle cannot linger', () => {
    const result = runBuild({ now: NOW });
    expect(readdirSync(DIST_DATA)).toHaveLength(result.files.length);
  });

  it('keeps every bundle small enough to load without pagination', () => {
    for (const file of runBuild({ now: NOW }).files) {
      expect(file.bytes).toBeLessThan(500 * 1024);
    }
  });
});
