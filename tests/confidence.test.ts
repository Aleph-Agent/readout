import { describe, expect, it } from 'vitest';

import { lastDetectionByRepo } from '../src/lib/confidence.ts';
import type { EventRecord } from '../src/types/events.ts';

function spike(repo: string, detectedAt: string, confidence: EventRecord['confidence']): EventRecord {
  return {
    id: `fork-spike:${repo}:${detectedAt.slice(0, 10)}`,
    kind: 'fork-spike',
    repo,
    detectedAt,
    confidence,
    summaryState: 'skipped',
    summary: null,
    summarySource: null,
    evidenceUrl: `https://github.com/${repo}`,
    metrics: {},
    supersedes: null,
  };
}

describe('lastDetectionByRepo', () => {
  it('finds a detection recorded in a previous month', () => {
    // Two-run confirmation reads this. Scoped to one month file, a spike
    // detected on the 31st would drop back to `detected` on the 1st and
    // confirmation would reset at every month boundary.
    const events = [
      spike('a/one', '2026-07-31T02:17:00Z', 'detected'),
      spike('b/two', '2026-08-01T02:17:00Z', 'detected'),
    ];
    expect(lastDetectionByRepo(events).get('a/one')).toBe('2026-07-31');
  });

  it('keeps the most recent detection per repository', () => {
    const events = [
      spike('a/one', '2026-08-01T02:17:00Z', 'detected'),
      spike('a/one', '2026-08-03T02:17:00Z', 'confirmed'),
      spike('a/one', '2026-08-02T02:17:00Z', 'detected'),
    ];
    expect(lastDetectionByRepo(events).get('a/one')).toBe('2026-08-03');
  });

  it('ignores events that never crossed the threshold', () => {
    const events = [spike('a/one', '2026-08-01T02:17:00Z', 'forming')];
    expect(lastDetectionByRepo(events).has('a/one')).toBe(false);
  });

  it('ignores other signal kinds', () => {
    const release: EventRecord = { ...spike('a/one', '2026-08-01T02:17:00Z', 'confirmed'), kind: 'release' };
    expect(lastDetectionByRepo([release]).size).toBe(0);
  });
});
