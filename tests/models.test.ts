import { describe, expect, it } from 'vitest';

import {
  collectModels,
  MIN_PRICE_MOVE,
  recordModelSample,
  type ModelClient,
} from '../src/collectors/models.ts';
import { templatedSentence } from '../src/lib/validate.ts';
import type { ModelRow } from '../src/types/models.ts';

/**
 * The first reading here with nothing to do with a repository, and the one with
 * the most dangerous failure mode: a catalogue that fails to load looks exactly
 * like every model on earth being withdrawn at once.
 */

const NOW = '2026-08-06T02:17:00.000Z';
const OPTIONS = { now: NOW, today: '2026-08-06', seen: new Set<string>() };

function entry(id: string, prompt: string, context = 128_000) {
  return { id, name: id, context_length: context, pricing: { prompt, completion: prompt } };
}

function row(over: Partial<ModelRow> = {}): ModelRow {
  return {
    id: 'acme/one',
    provider: 'acme',
    name: 'acme/one',
    prompt: 1,
    completion: 2,
    context: 128_000,
    firstSeen: '2026-07-01',
    lastSeen: '2026-08-05',
    available: true,
    samples: [],
    ...over,
  };
}

function stub(entries: ReturnType<typeof entry>[]): ModelClient {
  return { catalogue: async () => entries, requests: () => 1 };
}

describe('reading the catalogue', () => {
  it('says nothing on a first read', async () => {
    // 400 models arriving at once is a starting point, not four hundred price
    // changes.
    const result = await collectModels([], {
      ...OPTIONS,
      client: stub([entry('acme/one', '0.000001')]),
    });

    expect(result.rows).toHaveLength(1);
    expect(result.events).toHaveLength(0);
  });

  it('converts per-token pricing to per million', async () => {
    const result = await collectModels([], {
      ...OPTIONS,
      client: stub([entry('acme/one', '0.0000025')]),
    });
    expect(result.rows[0]?.prompt).toBe(2.5);
  });

  it('keeps the date it was first seen across runs', async () => {
    const result = await collectModels([row({ firstSeen: '2026-01-01' })], {
      ...OPTIONS,
      client: stub([entry('acme/one', '0.000001')]),
    });
    expect(result.rows[0]?.firstSeen).toBe('2026-01-01');
  });
});

describe('a price that moved', () => {
  it('reports the move with both ends', async () => {
    const result = await collectModels([row({ prompt: 1 })], {
      ...OPTIONS,
      client: stub([entry('acme/one', '0.000005')]),
    });

    expect(result.events[0]?.kind).toBe('model-price');
    expect(result.events[0]?.metrics['from']).toBe(1);
    expect(result.events[0]?.metrics['to']).toBe(5);
  });

  it('ignores a move below the rounding floor', async () => {
    // Prices are quoted per token and multiplied up, so the last decimal moves
    // on its own. That is arithmetic, not a decision by anybody.
    const tiny = (1 + MIN_PRICE_MOVE / 2) / 1_000_000;
    const result = await collectModels([row({ prompt: 1 })], {
      ...OPTIONS,
      client: stub([entry('acme/one', String(tiny))]),
    });
    expect(result.events).toHaveLength(0);
  });

  it('reports nothing twice for the same day', async () => {
    const first = await collectModels([row({ prompt: 1 })], {
      ...OPTIONS,
      client: stub([entry('acme/one', '0.000005')]),
    });
    const again = await collectModels([row({ prompt: 1 })], {
      ...OPTIONS,
      seen: new Set([first.events[0]?.id as string]),
      client: stub([entry('acme/one', '0.000005')]),
    });
    expect(again.events).toHaveLength(0);
  });
});

describe('a model that disappeared', () => {
  it('reports it and keeps the row', async () => {
    // Nobody else records this. A withdrawn model is simply gone from every
    // catalogue the next day, and this row is the only evidence it was offered.
    const result = await collectModels([row()], {
      ...OPTIONS,
      client: stub([entry('other/two', '0.000001')]),
    });

    const withdrawn = result.events.find((event) => event.kind === 'model-withdrawn');
    expect(withdrawn?.repo).toBe('acme/one');
    expect(withdrawn?.metrics['lastPrice']).toBe(1);
    expect(result.rows.find((r) => r.id === 'acme/one')?.available).toBe(false);
  });

  it('does not report it again the next day', async () => {
    const result = await collectModels([row({ available: false })], {
      ...OPTIONS,
      client: stub([entry('other/two', '0.000001')]),
    });
    expect(result.events).toHaveLength(0);
  });
});

describe('when the catalogue cannot be read', () => {
  it('writes nothing rather than withdrawing everything', async () => {
    // The loudest false claim available here: one timeout marking every model
    // on the list as no longer offered.
    const failing: ModelClient = {
      catalogue: async () => {
        throw new Error('timeout');
      },
      requests: () => 1,
    };
    const result = await collectModels([row()], { ...OPTIONS, client: failing });

    expect(result.events).toHaveLength(0);
    expect(result.rows[0]?.available).toBe(true);
    expect(result.errors[0]).toContain('timeout');
  });

  it('treats an empty catalogue the same way', async () => {
    const result = await collectModels([row()], { ...OPTIONS, client: stub([]) });

    expect(result.events).toHaveLength(0);
    expect(result.rows[0]?.available).toBe(true);
  });
});

describe('the trend', () => {
  it('keeps one reading a day', () => {
    const first = recordModelSample([], { at: NOW, prompt: 1, completion: 2, context: 100 });
    const again = recordModelSample(first, {
      at: '2026-08-06T18:00:00.000Z',
      prompt: 1,
      completion: 2,
      context: 100,
    });
    expect(again).toHaveLength(1);
  });

  it('stays bounded', () => {
    let samples = recordModelSample([], { at: '2026-06-01T00:00:00.000Z', prompt: 1, completion: 1, context: 1 });
    for (let day = 2; day <= 70; day += 1) {
      const at = new Date(Date.UTC(2026, 5, day)).toISOString();
      samples = recordModelSample(samples, { at, prompt: day, completion: day, context: 1 });
    }
    expect(samples.length).toBeLessThanOrEqual(36);
  });
});

describe('the sentence', () => {
  it('states the direction and both ends, with no model involved', async () => {
    const result = await collectModels([row({ prompt: 1 })], {
      ...OPTIONS,
      client: stub([entry('acme/one', '0.000005')]),
    });
    expect(templatedSentence(result.events[0] as never)).toBe(
      'acme/one rose from $1 to $5 per million prompt tokens.',
    );
  });
});
