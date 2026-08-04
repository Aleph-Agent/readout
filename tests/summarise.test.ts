import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPacer } from '../src/lib/llm.ts';
import type { LlmClient } from '../src/lib/llm.ts';
import type { EventRecord } from '../src/types/events.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'signal-summarise-'));
process.env['SIGNAL_DATA_DIR'] = dataDir;

const ledger = await import('../src/lib/ledger.ts');
const { runSummarise } = await import('../src/jobs/summarise.ts');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env['SIGNAL_DATA_DIR'];
});

const METRICS = {
  forksAdded: 60,
  observationHours: 24,
  baselinePerDay: 2.5,
  baselineDays: 19,
  multiplier: 24,
  multiplierCapped: 'no',
  totalForks: 260,
};

function event(id: string, summaryState: EventRecord['summaryState'] = 'pending'): EventRecord {
  return {
    id,
    kind: 'fork-spike',
    repo: 'owner/repo',
    detectedAt: '2026-08-04T02:17:00Z',
    confidence: 'confirmed',
    summaryState,
    summary: null,
    evidenceUrl: 'https://github.com/owner/repo',
    metrics: METRICS,
    supersedes: null,
  };
}

/** A model that always says the same thing, and counts how often it is asked. */
function stubModel(reply: string | (() => string)): LlmClient & { count: () => number } {
  let count = 0;
  return {
    model: 'stub-model',
    calls: () => count,
    count: () => count,
    complete: async () => {
      count += 1;
      return typeof reply === 'function' ? reply() : reply;
    },
  };
}

beforeEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('summarisation outcomes', () => {
  it('keeps prose whose numbers are all in the record', async () => {
    ledger.appendEvents('2026-08', [event('a')]);
    const client = stubModel("Forks rose by 60 over 24 hours, 24× this repository's 19-day baseline.");

    const result = await runSummarise({ client });

    expect(result.fromModel).toBe(1);
    expect(ledger.readSummaries()[0]?.source).toBe('model');
    expect(ledger.readSummaries()[0]?.state).toBe('summarised');
  });

  it('discards a hallucinated number and substitutes a templated sentence', async () => {
    ledger.appendEvents('2026-08', [event('a')]);
    const client = stubModel('Forks rose by 60 after 12,000 developers migrated.');

    const result = await runSummarise({ client });

    expect(result.fromModel).toBe(0);
    expect(result.fromTemplate).toBe(1);

    const stored = ledger.readSummaries()[0];
    expect(stored?.source).toBe('template');
    expect(stored?.text).not.toContain('12,000');
    // Nothing the model wrote survives. The fallback is rebuilt from the record.
    expect(stored?.text).toBe("Forks rose by 60 over 24 hours, 24× this repository's 19-day baseline.");
  });

  it('treats INSUFFICIENT as a success with no prose attached', async () => {
    ledger.appendEvents('2026-08', [event('a')]);
    const result = await runSummarise({ client: stubModel('INSUFFICIENT') });

    expect(result.insufficient).toBe(1);
    expect(ledger.readSummaries()[0]).toMatchObject({
      state: 'skipped',
      text: null,
      insufficient: true,
    });
  });
});

describe('never re-summarising', () => {
  it('produces zero additional calls when the pass is repeated', async () => {
    // Without this the 4-hourly cadence multiplies LLM usage sixfold and breaks
    // the free-tier budget inside a day.
    ledger.appendEvents('2026-08', [event('a'), event('b')]);
    const client = stubModel('Fork activity moved above its recent baseline.');

    await runSummarise({ client });
    expect(client.count()).toBe(2);

    await runSummarise({ client });
    expect(client.count()).toBe(2);
  });

  it('ignores events their collector marked skipped', async () => {
    // Clearing the significance threshold is the collector's decision.
    ledger.appendEvents('2026-08', [event('a', 'skipped')]);
    const client = stubModel('anything');

    const result = await runSummarise({ client });

    expect(client.count()).toBe(0);
    expect(result.attempted).toBe(0);
  });

  it('leaves an event pending when the call itself failed', async () => {
    ledger.appendEvents('2026-08', [event('a')]);

    const failing: LlmClient = {
      model: 'stub-model',
      calls: () => 1,
      complete: async () => {
        throw new Error('connection reset');
      },
    };

    const first = await runSummarise({ client: failing });
    expect(first.failed).toHaveLength(1);
    expect(ledger.readSummaries()).toHaveLength(0);

    // Next run retries rather than treating a transport failure as an answer.
    const second = await runSummarise({ client: stubModel('Fork activity moved.') });
    expect(second.fromModel).toBe(1);
  });
});

describe('observability', () => {
  it('logs the cumulative INSUFFICIENT rate to meta', async () => {
    ledger.appendEvents('2026-08', [event('a'), event('b'), event('c'), event('d')]);

    let call = 0;
    const client = stubModel(() => {
      call += 1;
      return call === 1 ? 'INSUFFICIENT' : 'Fork activity moved above its recent baseline.';
    });

    await runSummarise({ client });

    expect(ledger.readMeta().insufficientRate).toBeCloseTo(0.25, 6);
    expect(ledger.readMeta().summariesGenerated).toBe(3);
  });
});

describe('pacer', () => {
  it('waits rather than exceeding the tokens-per-minute ceiling', async () => {
    let clock = 0;
    const slept: number[] = [];
    const pacer = createPacer({
      requestsPerMinute: 30,
      tokensPerMinute: 6_000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    // Six calls of a thousand tokens fill the minute exactly.
    for (let i = 0; i < 6; i += 1) await pacer.acquire(1_000);
    expect(slept).toHaveLength(0);

    // The seventh has to wait for the first to age out.
    await pacer.acquire(1_000);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBe(60_000);
  });

  it('refuses a call that can never fit', async () => {
    const pacer = createPacer({ tokensPerMinute: 6_000, sleep: async () => {} });
    await expect(pacer.acquire(9_000)).rejects.toThrow(/over the 6000\/minute ceiling/);
  });
});
