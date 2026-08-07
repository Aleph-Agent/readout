import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * How the daily job hands findings to the ledger.
 *
 * There are two routes and they must not both be taken for the same finding.
 * A collector either appends its own findings immediately — which two of them
 * do, because their "announce once" rule is settled by a ledger row written in
 * the same breath — or it pushes them into `events` for the single append at
 * the end. Doing both appends every finding twice, and the second append is
 * refused: `appendEvents` will not rewrite an id it has already seen.
 *
 * That refusal is the right rule. It also meant the job did not merely record a
 * duplicate, it threw, and the throw took the whole run with it — snapshot
 * written, meta never updated, every collector after the crash point skipped.
 *
 * It survived because it only fires on a day when one of those two collectors
 * actually has something to say. Model prices move perhaps weekly. The job ran
 * green for as long as nothing happened, which is the worst possible shape for
 * a bug in an instrument whose entire job is to notice when something does.
 *
 * Read from the source because there is no offline path into these collectors
 * to integration-test — they reach four third-party APIs and take no injected
 * client. That gap is the reason this needs a test at all, and this is the
 * cheapest thing that would have caught it.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/jobs/daily.ts', import.meta.url)),
  'utf8',
);

/** Statements, with comments stripped so prose about a call is not a call. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the daily job hands each finding to the ledger once', () => {
  it('never both appends a collector result and pushes it into the batch', () => {
    // `appendEvents(month, x.events)` paired anywhere with a loop pushing the
    // same `x.events` into the batch is the double append.
    const appended = [...CODE.matchAll(/appendEvents\(month,\s*(\w+)\.events\)/g)].map(
      (match) => match[1] as string,
    );

    expect(appended.length).toBeGreaterThan(0);

    for (const name of appended) {
      const pushesToo = new RegExp(`for \\(const \\w+ of ${name}\\.events\\) events\\.push`).test(
        CODE,
      );
      expect(pushesToo, `${name}.events is appended and also pushed into the batch`).toBe(false);
    }
  });

  it('still counts what the collectors appended for themselves', () => {
    // Otherwise moving an append off the batch quietly drops it from the run's
    // own report, and the meta record understates what the day found.
    expect(CODE).toContain('appendedByCollectors');
    expect(CODE).toMatch(/eventsDetected:\s*events\.length \+ appendedByCollectors/);

    const appended = [...CODE.matchAll(/appendEvents\(month,\s*(\w+)\.events\)/g)].map(
      (match) => match[1] as string,
    );

    for (const name of appended) {
      expect(
        new RegExp(`appendedByCollectors \\+= ${name}\\.events\\.length`).test(CODE),
        `${name}.events is appended but never counted`,
      ).toBe(true);
    }
  });

  it('keeps every collector non-fatal', () => {
    // One third-party API being down must cost its own reading and nothing
    // else. A collector outside a try block takes the snapshot with it.
    for (const call of ['collectModels', 'collectLifecycle', 'collectIncidents', 'collectHiring']) {
      const at = CODE.indexOf(`await ${call}(`);
      expect(at, `${call} is not called`).toBeGreaterThan(0);

      const before = CODE.slice(0, at);
      const opened = (before.match(/\btry\s*\{/g) ?? []).length;
      const closed = (before.match(/\}\s*catch\b/g) ?? []).length;
      expect(opened, `${call} runs outside a try block`).toBeGreaterThan(closed);
    }
  });

  it('never lets a failed read empty a ledger', () => {
    // Every one of these writes the previous rows back when the collector
    // returns nothing. Twenty feeds failing at once is a network problem, not
    // twenty providers that never had an incident.
    for (const write of ['writeLifecycle', 'writeIncidents', 'writeHiring']) {
      expect(CODE, `${write} can be handed an empty set`).toMatch(
        new RegExp(`${write}\\(\\w+\\.rows\\.length === 0 \\? \\w+ : \\w+\\.rows\\)`),
      );
    }
  });
});
