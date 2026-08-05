import { describe, expect, it } from 'vitest';

import { allowedNumbers, extractNumbers, templatedSentence, validateSummary } from '../src/lib/validate.ts';
import { isRefusal } from '../src/lib/prompt.ts';
import type { EventRecord } from '../src/types/events.ts';

const spikeMetrics = {
  forksAdded: 60,
  observationHours: 24,
  baselinePerDay: 2.5,
  baselineDays: 19,
  multiplier: 24,
  multiplierCapped: 'no',
  totalForks: 260,
};

const releaseMetrics = {
  tag: 'v1.2.3',
  publishedAt: '2026-08-04T09:00:00Z',
  previousTag: 'v1.2.2',
  forks: 260,
  stars: 2600,
};

function spike(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'fork-spike:owner/repo:2026-08-04',
    kind: 'fork-spike',
    repo: 'owner/repo',
    detectedAt: '2026-08-04T02:17:00Z',
    confidence: 'confirmed',
    summaryState: 'pending',
    summary: null,
    summarySource: null,
    evidenceUrl: 'https://github.com/owner/repo',
    metrics: spikeMetrics,
    supersedes: null,
    ...over,
  };
}

describe('extractNumbers', () => {
  it('finds integers, decimals, and grouped thousands', () => {
    expect(extractNumbers('60 forks, 2.5 baseline, 1,200 stars')).toEqual(['60', '2.5', '1,200']);
  });

  it('finds numbers welded to symbols', () => {
    expect(extractNumbers('rose 24× over 24h')).toEqual(['24', '24']);
  });
});

describe('allowedNumbers', () => {
  it('permits honest rounding of a value in the record', () => {
    const allowed = allowedNumbers({ baseline: 45.3 });
    expect(allowed.has('45.3')).toBe(true);
    expect(allowed.has('45')).toBe(true);
    // "approximately 50" discards precision that was available.
    expect(allowed.has('50')).toBe(false);
  });

  it('tokenises versions and dates the same way on both sides of the comparison', () => {
    // "v1.2.3" yields ["1.2", "3"], not ["1", "2", "3"]. What matters is not
    // which split is intuitive but that the record and the generated text are
    // split identically, so a quoted version always matches itself.
    const allowed = allowedNumbers(releaseMetrics);
    expect([...extractNumbers('v1.2.3')].every((token) => allowed.has(token))).toBe(true);
    expect([...extractNumbers('2026-08-04')].every((token) => allowed.has(token))).toBe(true);
  });
});

describe('quoting the record', () => {
  it('accepts a version and date copied from the record', () => {
    expect(validateSummary('owner/repo published v1.2.3 on 2026-08-04.', releaseMetrics).ok).toBe(
      true,
    );
  });

  it('rejects a version one digit off', () => {
    expect(validateSummary('owner/repo published v1.2.4.', releaseMetrics).ok).toBe(false);
  });
});

describe('validateSummary', () => {
  it('accepts prose whose every number is in the record', () => {
    const result = validateSummary(
      "Forks rose by 60 over 24 hours, 24× this repository's 19-day baseline.",
      spikeMetrics,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a hallucinated number', () => {
    // The one unrecoverable error. A wrong number is a credibility event.
    const result = validateSummary(
      'Forks rose by 60 over 24 hours after 12,000 developers starred the project.',
      spikeMetrics,
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/12,000 does not appear/);
  });

  it('rejects a plausible-looking number that is merely close', () => {
    const result = validateSummary('Forks rose by 61 over 24 hours.', spikeMetrics);
    expect(result.ok).toBe(false);
  });

  it('rejects more than two sentences', () => {
    const result = validateSummary('Forks rose by 60. Over 24 hours. That is 24× baseline.', spikeMetrics);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/3 sentences/);
  });

  it('rejects an exclamation mark', () => {
    expect(validateSummary('Forks rose by 60 over 24 hours!', spikeMetrics).ok).toBe(false);
  });

  it('rejects an empty response', () => {
    expect(validateSummary('   ', spikeMetrics).ok).toBe(false);
  });

  it('accepts prose with no numbers at all', () => {
    expect(validateSummary('Fork activity moved sharply above its recent baseline.', spikeMetrics).ok).toBe(
      true,
    );
  });
});

describe('isRefusal', () => {
  it('recognises the refusal in the shapes a model actually emits', () => {
    expect(isRefusal('INSUFFICIENT')).toBe(true);
    expect(isRefusal('  INSUFFICIENT.  ')).toBe(true);
    expect(isRefusal('insufficient')).toBe(true);
  });

  it('does not mistake prose that merely mentions it', () => {
    expect(isRefusal('The record is INSUFFICIENT to explain the change.')).toBe(false);
  });
});

describe('templatedSentence', () => {
  it('states a fork spike with both windows named', () => {
    // A delta with no duration is not a measurement, and a multiple with no
    // comparison window is not a claim.
    expect(templatedSentence(spike())).toBe(
      "Forks rose by 60 over 24 hours, 24× this repository's 19-day baseline.",
    );
  });

  it('bounds the figure when the multiplier was capped', () => {
    const capped = spike({
      metrics: { ...spikeMetrics, multiplier: 50, multiplierCapped: 'yes' },
    });
    expect(templatedSentence(capped)).toContain('more than 50×');
  });

  it('states a release without characterising it', () => {
    const release = spike({ kind: 'release', metrics: releaseMetrics });
    expect(templatedSentence(release)).toBe(
      'owner/repo published v1.2.3 on 2026-08-04, following v1.2.2.',
    );
  });

  it('returns null rather than asserting past the record', () => {
    expect(templatedSentence(spike({ metrics: { forksAdded: 60 } }))).toBeNull();
    expect(templatedSentence(spike({ kind: 'lineage', metrics: {} }))).toBeNull();
  });

  it('produces sentences that pass their own validator', () => {
    // The fallback must never itself introduce a number outside the record —
    // it is the thing trusted when the model cannot be.
    expect(validateSummary(templatedSentence(spike()) as string, spikeMetrics).ok).toBe(true);

    const release = spike({ kind: 'release', metrics: releaseMetrics });
    expect(validateSummary(templatedSentence(release) as string, releaseMetrics).ok).toBe(true);
  });
});
