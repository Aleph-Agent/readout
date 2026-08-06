import { describe, expect, it } from 'vitest';

import { collectLicences } from '../src/collectors/licences.ts';
import { templatedSentence } from '../src/lib/validate.ts';
import type { LiveStateRow } from '../src/types/state.ts';

/**
 * The only detector here that needs no threshold and cannot produce a false
 * positive. Four of five of the others currently sit above anything that
 * happens in the real world; this one either sees a changed field or it does
 * not, which is why it is worth having even though it will fire rarely.
 */

const OPTIONS = { now: '2026-08-06T04:17:00.000Z', today: '2026-08-06', seen: new Set<string>() };

function row(over: Partial<LiveStateRow> = {}): LiveStateRow {
  return {
    id: 'a/one',
    fullName: 'a/one',
    active: true,
    forks: 100,
    stars: 1000,
    openIssues: 10,
    language: 'Go',
    pushedAt: null,
    license: 'MIT',
    archived: false,
    latestReleaseTag: null,
    latestReleaseAt: null,
    etag: null,
    releaseEtag: null,
    ...over,
  };
}

function before(over: Partial<LiveStateRow> = {}): Map<string, LiveStateRow> {
  return new Map([['a/one', row(over)]]);
}

describe('relicensing', () => {
  it('reports the move and both ends of it', () => {
    const events = collectLicences([row({ license: 'BUSL-1.1' })], before(), OPTIONS);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('licence');
    expect(events[0]?.metrics['from']).toBe('MIT');
    expect(events[0]?.metrics['to']).toBe('BUSL-1.1');
  });

  it('is confirmed on sight', () => {
    // Two-run confirmation exists for counts that can be manufactured. A field
    // that changed cannot become more true on a second reading.
    expect(collectLicences([row({ license: 'BUSL-1.1' })], before(), OPTIONS)[0]?.confidence).toBe(
      'confirmed',
    );
  });

  it('says nothing when the licence held', () => {
    expect(collectLicences([row()], before(), OPTIONS)).toHaveLength(0);
  });

  it('says nothing when the previous row predates the field', () => {
    // The failure this actually produced. `license` was added to the schema
    // after 400 state rows existed, `conform` fills a missing key with
    // undefined, and comparing against that published 207 licence changes in
    // one run — every repository appearing to relicense from "unidentified" to
    // whatever it had always been. All 207 were retracted.
    //
    // undefined is never-recorded and not comparable. null is recorded, and
    // means GitHub could not identify one.
    const legacy = new Map([['a/one', { ...row(), license: undefined as unknown as null }]]);
    expect(collectLicences([row({ license: 'Apache-2.0' })], legacy, OPTIONS)).toHaveLength(0);
  });

  it('still reports a move away from an unidentified licence once recorded', () => {
    // null is a real reading and a move off it is a real transition.
    const events = collectLicences([row({ license: 'MIT' })], before({ license: null }), OPTIONS);
    expect(events).toHaveLength(1);
    expect(events[0]?.metrics['from']).toBe('unidentified');
  });

  it('says nothing on a first reading', () => {
    // Otherwise every licence on the watchlist is announced as news on the day
    // the field was added.
    expect(collectLicences([row()], new Map(), OPTIONS)).toHaveLength(0);
  });

  it('words an unidentifiable licence as unidentified, never as a licence', () => {
    // GitHub returns NOASSERTION for a licence file it cannot parse. Storing
    // that string would make a project look like it relicensed to it.
    const events = collectLicences([row({ license: null })], before(), OPTIONS);
    expect(events[0]?.metrics['to']).toBe('unidentified');
  });

  it('reports nothing twice for the same day', () => {
    const first = collectLicences([row({ license: 'BUSL-1.1' })], before(), OPTIONS);
    const again = collectLicences([row({ license: 'BUSL-1.1' })], before(), {
      ...OPTIONS,
      seen: new Set([first[0]?.id as string]),
    });
    expect(again).toHaveLength(0);
  });
});

describe('archival', () => {
  it('reports a repository going read-only', () => {
    const events = collectLicences([row({ archived: true })], before(), OPTIONS);
    expect(events.map((event) => event.kind)).toContain('archived');
  });

  it('does not report it again once it is already archived', () => {
    const events = collectLicences([row({ archived: true })], before({ archived: true }), OPTIONS);
    expect(events).toHaveLength(0);
  });
});

describe('the sentence', () => {
  it('states the whole fact from the record, with no model involved', () => {
    const event = collectLicences([row({ license: 'BUSL-1.1' })], before(), OPTIONS)[0];
    expect(templatedSentence(event as never)).toBe(
      'a/one changed its licence from MIT to BUSL-1.1.',
    );
    expect(event?.summaryState).toBe('skipped');
  });
});
