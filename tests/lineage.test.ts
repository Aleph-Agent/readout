import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { collectLineage, DEFAULT_LINEAGE_THRESHOLDS } from '../src/collectors/lineage.ts';
import { templatedSentence, validateSummary } from '../src/lib/validate.ts';
import type { Descendant, HuggingFaceClient } from '../src/lib/huggingface.ts';
import type { EventRecord } from '../src/types/events.ts';
import type { LineageRoot } from '../src/types/lineage.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'signal-lineage-'));
process.env['SIGNAL_DATA_DIR'] = dataDir;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env['SIGNAL_DATA_DIR'];
});

beforeEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function root(over: Partial<LineageRoot> = {}): LineageRoot {
  return {
    id: 'meta-llama/Llama-3.1-8B',
    repo: 'meta-llama/llama3',
    added: '2026-08-01',
    active: true,
    seenThrough: '2026-08-01T00:00:00.000Z',
    descendants: 0,
    ...over,
  };
}

/** `count` models spread across `accounts` uploaders. */
function models(count: number, accounts: number): Descendant[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `acct${i % accounts}/model-${i}`,
    createdAt: `2026-08-0${(i % 5) + 2}T00:00:00.000Z`,
    downloads: i * 10,
    likes: i,
  }));
}

function stub(byRoot: Record<string, Descendant[]>): HuggingFaceClient & { caps: number[] } {
  const caps: number[] = [];
  return {
    caps,
    requests: () => 1,
    descendantsSince: async (base, _since, cap = 300) => {
      caps.push(cap);
      return byRoot[base] ?? [];
    },
  };
}

const OPTIONS = {
  now: '2026-08-09T03:17:00.000Z',
  today: '2026-08-09',
  seen: new Set<string>(),
};

describe('first read', () => {
  it('records a watermark and reports nothing', async () => {
    // Otherwise every model ever built on a root arrives at once, as though it
    // had all happened this week.
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(50, 20) });
    const result = await collectLineage(client, [root({ seenThrough: null })], OPTIONS);

    expect(result.events).toHaveLength(0);
    expect(result.roots[0]?.seenThrough).not.toBeNull();
  });

  it('counts nothing as gained, because nothing was', async () => {
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(50, 20) });
    const result = await collectLineage(client, [root({ seenThrough: null })], OPTIONS);
    expect(result.roots[0]?.descendants).toBe(0);
  });

  it('asks for one record, not three hundred', async () => {
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(1, 1) });
    await collectLineage(client, [root({ seenThrough: null })], OPTIONS);
    expect(client.caps[0]).toBe(1);
  });
});

describe('guards', () => {
  it('refuses a week that is mostly one uploader', async () => {
    // The first live sample from this API had its three newest descendants all
    // from one account. Bulk uploading is the lineage version of a fork farm.
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(40, 2) });
    const result = await collectLineage(client, [root()], OPTIONS);
    expect(result.events).toHaveLength(0);
  });

  it('refuses a quiet week', async () => {
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(4, 4) });
    expect((await collectLineage(client, [root()], OPTIONS)).events).toHaveLength(0);
  });

  it('skips a retired root without spending a request', async () => {
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(40, 20) });
    const result = await collectLineage(client, [root({ active: false })], OPTIONS);
    expect(client.caps).toHaveLength(0);
    expect(result.events).toHaveLength(0);
  });

  it('keeps the root when the API fails, so nothing is lost', async () => {
    const failing: HuggingFaceClient = {
      requests: () => 1,
      descendantsSince: async () => {
        throw new Error('gateway timeout');
      },
    };
    const before = root({ seenThrough: '2026-08-05T00:00:00.000Z', descendants: 12 });
    const result = await collectLineage(failing, [before], OPTIONS);

    expect(result.errors).toHaveLength(1);
    expect(result.roots[0]).toEqual(before);
  });
});

describe('a reported week', () => {
  it('records the count, the spread, and where to check it', async () => {
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(40, 20) });
    const event = (await collectLineage(client, [root()], OPTIONS)).events[0] as EventRecord;

    expect(event.kind).toBe('lineage');
    // Keyed to the watchlist repository, so it lands on a page a reader can
    // already navigate to.
    expect(event.repo).toBe('meta-llama/llama3');
    expect(event.confidence).toBe('confirmed');
    expect(event.metrics['newDescendants']).toBe(40);
    expect(event.metrics['uploaders']).toBe(20);
    expect(event.evidenceUrl).toContain('huggingface.co');
  });

  it('advances the watermark and the running total', async () => {
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(40, 20) });
    const result = await collectLineage(client, [root({ descendants: 12 })], OPTIONS);

    expect(result.roots[0]?.descendants).toBe(52);
    expect(result.roots[0]?.seenThrough).toBe('2026-08-06T00:00:00.000Z');
  });

  it('says declared, because that is all the data supports', async () => {
    // The base-model relation is written by whoever uploaded the model. It is
    // what they say they built on, and the sentence must not upgrade that.
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(40, 20) });
    const event = (await collectLineage(client, [root()], OPTIONS)).events[0] as EventRecord;
    const sentence = templatedSentence(event) as string;

    expect(sentence).toBe(
      '40 models from 20 accounts declared meta-llama/Llama-3.1-8B as their base model this week.',
    );
    expect(sentence).not.toMatch(/\bwere built on\b/);
    expect(validateSummary(sentence, event.metrics).ok).toBe(true);
  });

  it('reports nothing twice for the same week', async () => {
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(40, 20) });
    const first = await collectLineage(client, [root()], OPTIONS);
    const again = await collectLineage(client, [root()], {
      ...OPTIONS,
      seen: new Set([first.events[0]?.id as string]),
    });
    expect(again.events).toHaveLength(0);
  });
});

describe('calibration', () => {
  it('reports what each root gained, whether or not it crossed the bar', async () => {
    // A quarter where no root ever gained more than two models is a fact about
    // minNew, not about model lineage — and only knowable if the quiet weeks
    // were recorded at the time.
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(4, 4) });
    const result = await collectLineage(client, [root()], OPTIONS);

    expect(result.events).toHaveLength(0);
    expect(result.observations).toEqual([4]);
  });

  it('excludes a first read, which gains nothing by definition', async () => {
    const client = stub({ 'meta-llama/Llama-3.1-8B': models(50, 20) });
    const result = await collectLineage(client, [root({ seenThrough: null })], OPTIONS);
    expect(result.observations).toEqual([]);
  });
});

describe('thresholds', () => {
  it('is set where a week has to be broad as well as busy', () => {
    expect(DEFAULT_LINEAGE_THRESHOLDS.minNew).toBeGreaterThan(1);
    expect(DEFAULT_LINEAGE_THRESHOLDS.minAccounts).toBeGreaterThan(1);
  });
});
