import { describe, expect, it } from 'vitest';

import {
  classifyPeers,
  DEFAULT_PEER_THRESHOLDS,
  medianOf,
  type PeerObservation,
} from '../src/lib/peers.ts';
import { templatedSentence, validateSummary } from '../src/lib/validate.ts';
import type { EventRecord } from '../src/types/events.ts';

/** A category of ordinary repositories, each adding `delta` forks. */
function crowd(count: number, delta: number, category = 'ai-ml'): PeerObservation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `peer${i}/repo`,
    category,
    delta,
    windowHours: 26,
  }));
}

function loud(delta: number, category = 'ai-ml'): PeerObservation {
  return { id: 'loud/repo', category, delta, windowHours: 26 };
}

function verdictFor(id: string, observations: PeerObservation[]) {
  return classifyPeers(observations).find((v) => v.id === id);
}

describe('medianOf', () => {
  it('reports a value that was actually observed', () => {
    // The lower median of an even sample, not an average of two readings that
    // nobody recorded.
    expect(medianOf([1, 2, 3, 4])).toBe(2);
    expect(medianOf([5, 1, 3])).toBe(3);
  });

  it('has nothing to say about an empty sample', () => {
    expect(medianOf([])).toBeNull();
  });
});

describe('guards', () => {
  it('says insufficient while the window is still filling', () => {
    // This is the whole point of the peer comparison: it needs one day, not
    // fourteen. But it does need the one.
    const v = verdictFor('loud/repo', [...crowd(30, 1), { ...loud(400), windowHours: 6 }]);
    expect(v?.state).toBe('insufficient');
    expect(v?.reason).toMatch(/needs 24h/);
  });

  it('says insufficient when a category is too small to have a median', () => {
    const v = verdictFor('loud/repo', [...crowd(5, 1), loud(400)]);
    expect(v?.state).toBe('insufficient');
    expect(v?.reason).toMatch(/needs 20/);
  });

  it('applies the small-numbers floor before computing any ratio', () => {
    // Most repositories add nothing on a given day, so the category median is
    // often zero and any activity divides to infinity. The floor runs first.
    const v = verdictFor('loud/repo', [...crowd(30, 0), loud(10)]);
    expect(v?.state).toBe('quiet');
    expect(v?.ratio).toBeNull();
  });

  it('only lets the busiest few in a category qualify', () => {
    // Five categories at three each bounds the feed at fifteen findings a day.
    const busy = Array.from({ length: 6 }, (_, i) => ({
      id: `busy${i}/repo`,
      category: 'ai-ml',
      delta: 400 - i,
      windowHours: 26,
    }));
    const outliers = classifyPeers([...crowd(30, 1), ...busy]).filter((v) => v.state === 'outlier');

    expect(outliers).toHaveLength(DEFAULT_PEER_THRESHOLDS.maxRank);
    expect(outliers.map((v) => v.rank)).toEqual([1, 2, 3]);
  });

  it('stays quiet for activity that is merely above average', () => {
    const v = verdictFor('loud/repo', [...crowd(30, 10), loud(40)]);
    expect(v?.state).toBe('quiet');
    expect(v?.reason).toMatch(/threshold is 8x/);
  });
});

describe('outliers', () => {
  it('reports a repository well clear of its category', () => {
    const v = verdictFor('loud/repo', [...crowd(30, 2), loud(300)]);
    expect(v?.state).toBe('outlier');
    expect(v?.median).toBe(2);
    expect(v?.peers).toBe(31);
    expect(v?.rank).toBe(1);
    expect(v?.ratio).toBe(150);
  });

  it('bounds the displayed multiple without hiding the real one', () => {
    const v = verdictFor('loud/repo', [...crowd(30, 2), loud(300)]);
    expect(v?.displayRatio).toBe(DEFAULT_PEER_THRESHOLDS.displayCap);
    expect(v?.ratioCapped).toBe(true);
  });

  it('compares only within a category, never across them', () => {
    // A busy week for databases says nothing about what is normal for a
    // model repository.
    const observations = [...crowd(30, 2, 'ai-ml'), ...crowd(30, 200, 'database'), loud(300)];
    const v = verdictFor('loud/repo', observations);
    expect(v?.median).toBe(2);
    expect(v?.state).toBe('outlier');
  });

  it('excludes unmeasured repositories from the median', () => {
    // Counting them would drag the median toward zero and manufacture
    // outliers out of ordinary activity.
    const unmeasured = Array.from({ length: 40 }, (_, i) => ({
      id: `new${i}/repo`,
      category: 'ai-ml',
      delta: 0,
      windowHours: 2,
    }));
    const v = verdictFor('loud/repo', [...crowd(30, 20), ...unmeasured, loud(300)]);
    expect(v?.median).toBe(20);
    expect(v?.peers).toBe(31);
  });
});

describe('what it is allowed to say', () => {
  const event: EventRecord = {
    id: 'fork-outlier:loud/repo:2026-08-06',
    kind: 'fork-outlier',
    repo: 'loud/repo',
    detectedAt: '2026-08-06T02:17:00Z',
    confidence: 'confirmed',
    summaryState: 'pending',
    summary: null,
    summarySource: null,
    evidenceUrl: 'https://github.com/loud/repo',
    metrics: {
      forksAdded: 300,
      observationHours: 26,
      category: 'ai-ml',
      categoryMedian: 2,
      peers: 31,
      rankInCategory: 1,
      ratioToMedian: 50,
      ratioCapped: 'yes',
    },
  supersedes: null,
  };

  it('names the comparison group and how big it was', () => {
    // A multiple of a median means nothing without the sample size.
    expect(templatedSentence(event)).toBe(
      'loud/repo added 300 forks over 26 hours; the median of the 31 ai-ml repositories measured was 2.',
    );
  });

  it('never claims a history it does not have', () => {
    const sentence = templatedSentence(event) as string;
    expect(sentence).not.toContain('baseline');
    expect(sentence).not.toContain('30-day');
  });

  it('passes the validator it exists to satisfy', () => {
    expect(validateSummary(templatedSentence(event) as string, event.metrics).ok).toBe(true);
  });
});
