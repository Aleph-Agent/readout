import { describe, expect, it } from 'vitest';

import { summariseModels } from '../src/lib/models-summary.ts';
import type { ModelRow } from '../src/types/models.ts';

function row(over: Partial<ModelRow> = {}): ModelRow {
  return {
    id: 'acme/one',
    provider: 'acme',
    name: 'acme/one',
    prompt: 1,
    completion: 2,
    context: 128_000,
    firstSeen: '2026-07-01',
    lastSeen: '2026-08-06',
    available: true,
    samples: [],
    ...over,
  };
}

describe('the price list', () => {
  it('excludes free tiers from both ends', () => {
    // Zero is not the lowest price. It is a different offer — usually
    // rate-limited, often a preview — and putting it at the top of a price
    // table would say something untrue.
    const summary = summariseModels([
      row({ id: 'free/one', prompt: 0 }),
      row({ id: 'cheap/one', prompt: 0.5 }),
    ]);

    expect(summary.cheapest.map((m) => m.id)).toEqual(['cheap/one']);
    expect(summary.dearest.map((m) => m.id)).toEqual(['cheap/one']);
  });

  it('counts a free model as offered even though it is not priced', () => {
    expect(summariseModels([row({ prompt: 0 })]).available).toBe(1);
  });

  it('leaves a withdrawn model out of the price list and counts it', () => {
    const summary = summariseModels([row({ available: false }), row({ id: 'b/two' })]);

    expect(summary.withdrawn).toBe(1);
    expect(summary.available).toBe(1);
    expect(summary.cheapest.map((m) => m.id)).toEqual(['b/two']);
  });

  it('breaks price ties by name, so the bundle is byte-identical run to run', () => {
    const summary = summariseModels([row({ id: 'b/two' }), row({ id: 'a/one' })]);
    expect(summary.cheapest.map((m) => m.id)).toEqual(['a/one', 'b/two']);
  });
});

describe('movement', () => {
  const samples = [
    { at: '2026-07-20T00:00:00.000Z', prompt: 1, completion: 2, context: 1 },
    { at: '2026-08-01T00:00:00.000Z', prompt: 2, completion: 2, context: 1 },
    { at: '2026-08-06T00:00:00.000Z', prompt: 3, completion: 2, context: 1 },
  ];

  it('measures against the oldest reading held, not against yesterday', () => {
    // A price that drifted over three weeks moved. A day-on-day diff reports
    // nothing on every one of those days.
    const summary = summariseModels([row({ prompt: 3, samples })]);
    expect(summary.moved[0]?.moved).toBe(2);
  });

  it('leaves a model with one reading out of the moved list', () => {
    const summary = summariseModels([row({ samples: [samples[0] as never] })]);
    expect(summary.moved).toHaveLength(0);
  });

  it('orders by size of move regardless of direction', () => {
    const down = row({
      id: 'down/one',
      prompt: 1,
      samples: [
        { at: '2026-07-20T00:00:00.000Z', prompt: 9, completion: 1, context: 1 },
        { at: '2026-08-06T00:00:00.000Z', prompt: 1, completion: 1, context: 1 },
      ],
    });
    const summary = summariseModels([row({ prompt: 3, samples }), down]);

    expect(summary.moved[0]?.id).toBe('down/one');
    expect(summary.moved[0]?.moved).toBe(-8);
  });
});
