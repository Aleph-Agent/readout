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
  return { id, category: 'devtool', added: '2026-08-04', active: true, packages: [] };
}

function stateRow(id: string, forks: number): LiveStateRow {
  return {
    id,
    fullName: id,
    active: true,
    forks,
    stars: forks * 10,
    openIssues: 2,
    language: 'TypeScript',
    pushedAt: '2026-08-04T00:00:00Z',
    license: null,
    archived: false,
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
    summarySource: null,
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
  it('emits one bundle per lens, plus an index, meta, and the ask record', () => {
    runBuild({ now: NOW });
    const names = readdirSync(DIST_DATA).sort();
    expect(names).toEqual([
      // What the answer endpoint is allowed to answer from. Published rather
      // than held server-side, so the grounding is checkable by the reader.
      'ask-context.json',
      // Every repository flattened across every axis, for /compare. Fetched
      // only by that page, never by the index.
      'compare.json',
      'demand.json',
      'ecosystem.json',
      // When each tracked runtime stops getting security fixes. The one class
      // of question where a model answering from training data is confidently
      // wrong, because the answer is a date that has since passed.
      'eol.json',
      'forks.json',
      'incidents.json',
      'index.json',
      'lineage.json',
      'meta.json',
      // Every model, flat, for the endpoint that answers "cheapest with 200k
      // context" — a question an agent asks several times a session.
      'models.json',
      'ships.json',
      'stack-index.json',
      'stack.json',
    ]);
  });

  it('can still say "no collector yet" as distinct from "nothing detected"', () => {
    // Both render as an empty list, and only the data can say which is which.
    // Every lens now has a collector, so all five report active — but the
    // distinction stays wired, because a sixth lens would need it on day one.
    for (const lens of ['ships', 'forks', 'demand', 'stack', 'lineage']) {
      expect(read<LensBundle>(`${lens}.json`).status).toBe('active');
    }
    expect(read<LensBundle>('forks.json').records).toEqual([]);
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

  it('rebuilds from scratch so a removed file cannot linger', () => {
    const result = runBuild({ now: NOW });
    const jsonFiles = result.files.filter((f) => f.name.endsWith('.json'));
    expect(readdirSync(DIST_DATA).sort()).toEqual(jsonFiles.map((f) => f.name).sort());
  });

  it('emits a page per lens alongside the bundles', () => {
    const result = runBuild({ now: NOW });
    const pages = result.files
      .filter(
        (f) =>
          f.name.endsWith('.html') && !f.name.startsWith('repo/') && !f.name.startsWith('e/'),
      )
      .map((f) => f.name);
    expect(pages.sort()).toEqual([
      // The one page here that is a tool rather than a reading.
      'compare.html',
      'demand.html',
      // The dependency graph read backwards, from manifests rather than a counter.
      'depends.html',
      // The readings that never touch GitHub: registries, OSV, Stack Overflow.
      'ecosystem.html',
      // The one page that makes a claim rather than showing a reading.
      'findings.html',
      'forks.html',
      // Who goes down and how often, kept after their own feeds forget.
      'incidents.html',
      'index.html',
      'lineage.html',
      // The instrument.  is the front door now; this is what used to be there.
      'live.html',
      // How the readings are taken and what they cannot support. It was all in
      // the commit log, which is a credibility argument aimed at an audience
      // that does not read strangers' commit logs.
      'method.html',
      // What models cost. The first page here with nothing to do with a
      // repository.
      'models.html',
      // The channel list: every reading and the question it answers, on one
      // screen. Fifteen one-word navigation labels never said any of it.
      'readings.html',
      'ships.html',
      'stack.html',
      // Everything the ledger already holds, arranged for somebody who was away.
      'week.html',
    ]);
  });

  it('gives every finding its own address, and none to retractions', () => {
    // What anybody shares is one reading, so one reading needs a URL. A
    // correction that replaces a claim is itself a finding and keeps its page;
    // a withdrawal has nothing to show and the lens already counts it.
    ledger.appendEvents('2026-08', [
      {
        ...releaseEvent('release:c/three:v9.0.0', 'c/three', '2026-08-04T11:00:00Z'),
      },
      {
        ...releaseEvent('correction:withdrawn:1', 'c/three', '2026-08-04T11:30:00Z'),
        kind: 'correction',
        supersedes: 'release:c/three:v9.0.0',
        metrics: { withdrawn: 'yes' },
      },
    ]);

    const names = runBuild({ now: NOW }).files.map((f) => f.name);

    expect(names.filter((n) => n.startsWith('e/')).length).toBeGreaterThan(0);
    expect(names).not.toContain('e/correction-withdrawn-1.html');
    // The claim it withdrew is gone too, since it was superseded.
    expect(names).not.toContain('e/release-c-three-v9-0-0.html');
  });

  it('refuses to ship a link that goes nowhere', () => {
    // 141 of these shipped. Repository timelines linked every entry to its own
    // page, retractions included, and retractions have none.
    const built = runBuild({ now: NOW });
    const served = new Set(
      built.files
        .map((f) => `/${f.name.replace(/\.html$/, '')}`)
        // Copied into the output rather than generated into the page map, so
        // `files` does not list them. They are served all the same, and a test
        // whose model of "what is served" is narrower than reality reports a
        // dead link that is not one.
        .concat('/', '/favicon.svg', '/site.css', '/share.png'),
    );

    for (const file of built.files.filter((f) => f.name.endsWith('.html'))) {
      const html = readFileSync(join(distDir, file.name), 'utf8');
      for (const match of html.matchAll(/href="(\/[^"#?]*)"/g)) {
        const target = (match[1] as string).replace(/\/$/, '') || '/';
        if (/\.(css|json|xml|txt|woff2?)$/.test(target)) continue;
        expect(served.has(target), `${file.name} links to ${target}`).toBe(true);
      }
    }
  });

  it('emits a feed, a sitemap, and robots so the site can be found and followed', () => {
    const names = runBuild({ now: NOW }).files.map((f) => f.name);
    expect(names).toContain('feed.xml');
    expect(names).toContain('sitemap.xml');
    expect(names).toContain('robots.txt');
  });

  it('emits a profile page for every watched repository, events or not', () => {
    // A repository the agent has never had anything to say about still gets a
    // page. A 404 reads as a broken link, not as an honest silence.
    const result = runBuild({ now: NOW });
    const profiles = result.files
      .filter((f) => f.name.startsWith('repo/'))
      .map((f) => f.name)
      .sort();
    // A page each, and a feed each for the ones with a confirmed finding. The
    // site-wide feed is four hundred projects of noise to somebody who depends
    // on one of them.
    expect(profiles).toEqual([
      'repo/a/one.html',
      'repo/a/one.xml',
      'repo/b/two.html',
      'repo/b/two.xml',
    ]);
  });

  it('deploys when only the stylesheet changed', () => {
    // Hashing the JSON alone would mean a CSS edit never reached the site.
    const built = runBuild({ now: NOW });
    recordDeploy(built.bundleHash, true);
    expect(runBuild({ now: NOW }).deploy).toBe(false);

    ledger.writeMeta({ ...ledger.readMeta(), lastSuccessfulRunAt: '2026-08-04T16:17:00Z' });
    // A fresh reading time is content: the page derives its staleness warning
    // from it, so a skipped deploy would make a healthy agent look dead.
    expect(runBuild({ now: NOW }).deploy).toBe(true);
  });

  it('keeps every bundle small enough to load without pagination', () => {
    for (const file of runBuild({ now: NOW }).files) {
      expect(file.bytes).toBeLessThan(500 * 1024);
    }
  });
});
