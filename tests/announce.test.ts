import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { authorizationHeader, postLength, createXClient, type XClient } from '../src/lib/x.ts';
import { scoreFindings } from '../src/lib/scorecard.ts';
import type { EventRecord } from '../src/types/events.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'signal-announce-'));
process.env['SIGNAL_DATA_DIR'] = dataDir;

const ledger = await import('../src/lib/ledger.ts');
const { runAnnounce, composePost } = await import('../src/jobs/announce.ts');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env['SIGNAL_DATA_DIR'];
});

beforeEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const SPIKE_METRICS = {
  forksAdded: 60,
  observationHours: 24,
  baselinePerDay: 2.5,
  baselineDays: 19,
  multiplier: 24,
  multiplierCapped: 'no',
  totalForks: 260,
};

function finding(id: string, over: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    kind: 'fork-spike',
    repo: 'owner/repo',
    detectedAt: '2026-08-04T02:17:00Z',
    confidence: 'confirmed',
    summaryState: 'pending',
    summary: null,
    summarySource: null,
    evidenceUrl: 'https://github.com/owner/repo',
    metrics: SPIKE_METRICS,
    supersedes: null,
    ...over,
  };
}

function stubX(): XClient & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    posts: () => sent.length,
    post: async (text: string) => {
      sent.push(text);
      return { id: `post${sent.length}` };
    },
  };
}

describe('OAuth 1.0a signing', () => {
  it('produces a stable signature for identical inputs', () => {
    const creds = { apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'ts' };
    const at = () => 1_780_000_000_000;
    const nonce = () => 'fixednonce';

    const a = authorizationHeader('POST', 'https://api.x.com/2/tweets', creds, at, nonce);
    const b = authorizationHeader('POST', 'https://api.x.com/2/tweets', creds, at, nonce);

    expect(a).toBe(b);
    expect(a).toMatch(/^OAuth /);
    expect(a).toContain('oauth_signature_method="HMAC-SHA1"');
  });

  it('changes when any credential changes', () => {
    const at = () => 1_780_000_000_000;
    const nonce = () => 'fixednonce';
    const base = { apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'ts' };

    const a = authorizationHeader('POST', 'https://api.x.com/2/tweets', base, at, nonce);
    const b = authorizationHeader(
      'POST',
      'https://api.x.com/2/tweets',
      { ...base, accessSecret: 'other' },
      at,
      nonce,
    );
    expect(a).not.toBe(b);
  });

  it('refuses a credential that cannot go in a header', () => {
    expect(() =>
      createXClient({
        credentials: { apiKey: '﻿k', apiSecret: 's', accessToken: 't', accessSecret: 'ts' },
      }),
    ).toThrow(/byte order mark/);
  });
});

describe('post length', () => {
  it('counts a link as X counts it, not as characters', () => {
    const long = 'https://readout-7pt.pages.dev/e/a-very-long-slug-that-keeps-going-and-going';
    expect(postLength(long)).toBe(23);
  });
});

describe('what gets announced', () => {
  it('posts a confirmed finding with the templated sentence and its link', () => {
    const text = composePost(finding('fork-spike:owner/repo:2026-08-04')) as string;
    expect(text).toContain("Forks rose by 60 over 24 hours, 24× this repository's 19-day baseline.");
    expect(text).toContain('/e/fork-spike-owner-repo-2026-08-04');
    // No hashtags, no exclamation, no adjectives. The numbers are the point.
    expect(text).not.toContain('#');
    expect(text).not.toContain('!');
  });

  it('never announces a detection that was not confirmed', async () => {
    ledger.appendEvents('2026-08', [finding('a', { confidence: 'detected' })]);
    const client = stubX();
    const result = await runAnnounce({ client });

    expect(result.eligible).toBe(0);
    expect(client.sent).toHaveLength(0);
  });

  it('never announces a finding that has since been retracted', async () => {
    // Confirmed when recorded, withdrawn afterwards. A post cannot be taken
    // back, so the retraction has to win.
    ledger.appendEvents('2026-08', [
      finding('a'),
      finding('c1', { kind: 'correction', supersedes: 'a', metrics: { withdrawn: 'yes' } }),
    ]);

    const client = stubX();
    await runAnnounce({ client });
    expect(client.sent).toHaveLength(0);
  });

  it('posts each finding exactly once, however often it runs', async () => {
    ledger.appendEvents('2026-08', [finding('a'), finding('b')]);
    const client = stubX();

    await runAnnounce({ client });
    expect(client.sent).toHaveLength(2);

    await runAnnounce({ client });
    expect(client.sent).toHaveLength(2);
  });

  it('caps how many go out in one run', async () => {
    ledger.appendEvents('2026-08', ['a', 'b', 'c', 'd', 'e'].map((id) => finding(id)));
    const client = stubX();

    await runAnnounce({ client, limit: 2 });
    expect(client.sent).toHaveLength(2);
    expect(ledger.readAnnouncements()).toHaveLength(2);
  });

  it('leaves a finding unposted when the call failed, so it retries', async () => {
    ledger.appendEvents('2026-08', [finding('a')]);
    const failing: XClient = {
      posts: () => 1,
      post: async () => {
        throw new Error('connection reset');
      },
    };

    const first = await runAnnounce({ client: failing });
    expect(first.failed).toHaveLength(1);
    expect(ledger.readAnnouncements()).toHaveLength(0);

    const client = stubX();
    await runAnnounce({ client });
    expect(client.sent).toHaveLength(1);
  });

  it('records a skip when no true sentence fits, rather than reconsidering forever', async () => {
    ledger.appendEvents('2026-08', [finding('a', { kind: 'lineage', metrics: {} })]);
    const client = stubX();

    const result = await runAnnounce({ client });
    expect(result.skipped).toBe(1);
    expect(client.sent).toHaveLength(0);
    expect(ledger.readAnnouncements()[0]?.state).toBe('failed');
  });
});

describe('the project scoring itself', () => {
  const NOW = new Date('2026-09-01T00:00:00Z');

  function release(repo: string, at: string): EventRecord {
    return finding(`release:${repo}:${at}`, { kind: 'release', repo, detectedAt: at });
  }

  it('says nothing below a usable sample', () => {
    const score = scoreFindings([finding('a', { detectedAt: '2026-08-01T00:00:00Z' })], NOW);
    expect(score.rate).toBeNull();
    expect(score.resolved).toBe(1);
  });

  it('reports the rate once there is enough to report', () => {
    const events: EventRecord[] = [];
    for (let i = 0; i < 12; i += 1) {
      const repo = `r${i}/x`;
      events.push(finding(`s${i}`, { repo, detectedAt: '2026-08-01T00:00:00Z' }));
      if (i < 9) events.push(release(repo, '2026-08-03T00:00:00Z'));
    }

    const score = scoreFindings(events, NOW);
    expect(score.resolved).toBe(12);
    expect(score.followed).toBe(9);
    expect(score.rate).toBeCloseTo(0.75, 6);
  });

  it('does not count a release that arrived outside the window', () => {
    const events: EventRecord[] = [];
    for (let i = 0; i < 10; i += 1) {
      const repo = `r${i}/x`;
      events.push(finding(`s${i}`, { repo, detectedAt: '2026-08-01T00:00:00Z' }));
      events.push(release(repo, '2026-08-20T00:00:00Z'));
    }
    expect(scoreFindings(events, NOW).followed).toBe(0);
  });

  it('holds back findings still inside the window instead of scoring them early', () => {
    const recent = finding('r', { detectedAt: '2026-08-30T00:00:00Z' });
    const score = scoreFindings([recent], NOW);
    expect(score.pending).toBe(1);
    expect(score.resolved).toBe(0);
  });

  it('excludes retracted findings from its own arithmetic', () => {
    const events = [
      finding('a', { detectedAt: '2026-08-01T00:00:00Z' }),
      finding('c1', { kind: 'correction', supersedes: 'a', metrics: { withdrawn: 'yes' } }),
    ];
    expect(scoreFindings(events, NOW).resolved).toBe(0);
  });
});
