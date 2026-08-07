import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The daily job, end to end, against stand-ins.
 *
 * This is the test that did not exist when a model price move crashed the whole
 * run. Every collector it calls had a client interface already; none of them
 * was reachable from the job, so the only way to exercise the block was to run
 * it against four live APIs — which meant it went out unexercised, and the
 * defect was not in any collector but in the wiring between them.
 *
 * Runs against a scratch ledger through `SIGNAL_DATA_DIR`, so it never touches
 * the committed one.
 */

// Set before the job is imported: `paths.ts` resolves the ledger root at module
// load, and vitest caches a module per file, so this cannot move into a hook.
const dir = mkdtempSync(join(tmpdir(), 'readout-daily-'));
process.env['SIGNAL_DATA_DIR'] = dir;

const { runDaily } = await import('../src/jobs/daily.ts');

afterAll(() => {
  delete process.env['SIGNAL_DATA_DIR'];
});

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'live'), { recursive: true });
  mkdirSync(join(dir, 'events'), { recursive: true });
  mkdirSync(join(dir, 'history'), { recursive: true });

  writeFileSync(
    join(dir, 'live', 'state.jsonl'),
    `${JSON.stringify({
      id: 'a/one',
      fullName: 'a/one',
      forks: 100,
      stars: 1000,
      openIssues: 5,
      pushedAt: '2026-08-06T00:00:00Z',
      license: 'MIT',
      archived: false,
      language: 'TypeScript',
      observedAt: '2026-08-07T00:00:00Z',
      active: true,
    })}\n`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'watchlist.jsonl'),
    `${JSON.stringify({ id: 'a/one', category: 'devtool', added: '2026-07-01', active: true, packages: [] })}\n`,
    'utf8',
  );

});


const NOW = new Date('2026-08-07T02:17:00.000Z');

/**
 * A GitHub client that has nothing to say.
 *
 * Every collector under test reaches a third party that is not GitHub, but the
 * block they sit in also builds a GitHub client, and that refuses to exist
 * without a token. Supplying a silent one keeps the test about the wiring it is
 * meant to be about.
 */
const SILENT = {
  async getJson() {
    return { kind: 'missing' } as never;
  },
  stats: () => ({ consumed: 0, unchanged: 0, remaining: null }) as never,
  isExhausted: () => false,
};


function eventsFile(): string {
  const path = join(dir, 'events', '2026-08.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function ids(): string[] {
  return eventsFile()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

describe('the daily job with every third party stubbed', () => {
  it('records a model price move exactly once', async () => {
    // The crash. The models collector appended its own finding and then handed
    // the same finding to the batch appended at the end; `appendEvents` refuses
    // to rewrite an id it has seen, so the second write threw and took the run
    // with it. Nothing about it fired until a price actually moved.
    const entry = (id: string, prompt: string) => ({
      id,
      name: id,
      context_length: 128_000,
      pricing: { prompt, completion: prompt },
    });

    // First run establishes the price, second moves it.
    await runDaily({
      now: NOW,
      delayMs: 0,
      client: SILENT,
      collectors: { models: { async catalogue() { return [entry('acme/one', '0.000001')]; }, requests: () => 1 } },
    });

    const meta = await runDaily({
      now: new Date('2026-08-08T02:17:00.000Z'),
      delayMs: 0,
      client: SILENT,
      collectors: { models: { async catalogue() { return [entry('acme/one', '0.000009')]; }, requests: () => 1 } },
    });

    const seen = ids();
    expect(new Set(seen).size, 'an id was written twice').toBe(seen.length);
    expect(seen.filter((id) => id.startsWith('model-price:'))).toHaveLength(1);
    expect(meta.job).toBe('daily');
  });

  it('reports a collector failure without losing the run', async () => {
    // One third party being down costs its own reading and nothing else.
    const meta = await runDaily({
      now: NOW,
      delayMs: 0,
      client: SILENT,
      collectors: {
        models: {
          async catalogue() {
            throw new Error('502 from the catalogue');
          },
          requests: () => 1,
        },
        lifecycle: {
          async cycles() {
            throw new Error('socket hang up');
          },
          requests: () => 1,
        },
      },
    });

    // The snapshot is the thing that must survive: it is the only reading taken
    // once a day that cannot be taken again later.
    expect(existsSync(join(dir, 'history', '2026-08-07.jsonl'))).toBe(true);
    expect(meta.collectorsErrored.some((error) => error.includes('models'))).toBe(true);
    expect(meta.collectorsErrored.some((error) => error.includes('lifecycle'))).toBe(true);
  });

  it('never empties a ledger because a read came back empty', async () => {
    writeFileSync(
      join(dir, 'live', 'lifecycle.jsonl'),
      `${JSON.stringify({
        product: 'python',
        cycle: '3.9',
        eol: '2026-10-31',
        ended: false,
        latest: '3.9.20',
        lts: false,
        observedAt: '2026-08-01T00:00:00.000Z',
      })}\n`,
      'utf8',
    );

    await runDaily({
      now: NOW,
      delayMs: 0,
      client: SILENT,
      // Every product 404s. That is an API that moved, not two dozen products
      // that never had a release.
      collectors: { lifecycle: { async cycles() { return null; }, requests: () => 1 } },
    });

    const kept = readFileSync(join(dir, 'live', 'lifecycle.jsonl'), 'utf8');
    expect(kept).toContain('python');
  });

  it('writes what a stubbed collector actually returned', async () => {
    await runDaily({
      now: NOW,
      delayMs: 0,
      client: SILENT,
      collectors: {
        images: {
          async tag() {
            return { bytes: 409_000_000, updatedAt: '2026-08-05T00:00:00Z' };
          },
          requests: () => 1,
        },
        questions: {
          async total() {
            return 42;
          },
          requests: () => 1,
        },
      },
    });

    expect(readFileSync(join(dir, 'live', 'images.jsonl'), 'utf8')).toContain('409000000');
    expect(readFileSync(join(dir, 'live', 'questions.jsonl'), 'utf8')).toContain('"recent":42');
  });

  it('touches no third party when told to stay offline', async () => {
    // What a build does. If this ever reaches the network the suite becomes
    // dependent on four APIs being up, which is how a test suite stops being
    // run.
    const meta = await runDaily({ now: NOW, offline: true, client: SILENT });

    expect(existsSync(join(dir, 'live', 'images.jsonl'))).toBe(false);
    expect(meta.collectorsErrored).toEqual([]);
  });
});
