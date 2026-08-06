/**
 * Retract the 207 licence findings published by a schema migration.
 *
 * `license` was added to the state schema after 400 rows already existed.
 * `conform` fills a missing key with undefined, the collector compared against
 * that, and one pulse published a licence change for every repository on the
 * watchlist — each claiming a move from "unidentified" to whatever the project
 * had always been licensed under. Every one is false.
 *
 * They are superseded, not deleted. Events are append-only and the audit trail
 * is the product: a wrong finding that vanishes leaves a reader unable to tell
 * whether this project publishes carefully or just tidies up afterwards. The
 * correction appears in the same place with the same prominence.
 *
 *   node scripts/withdraw-licences.ts            # report only
 *   node scripts/withdraw-licences.ts --write
 */

import { appendEvents, listEventMonths, readEvents } from '../src/lib/ledger.ts';
import type { EventRecord } from '../src/types/events.ts';

const WRITE = process.argv.includes('--write');

/**
 * A finding is false when it claims a transition out of "unidentified".
 *
 * That is the exact shape the migration produced. A genuine move off an
 * unidentifiable licence is possible and would look the same, but none had been
 * observed before this run — the field did not exist until it.
 */
function isMigrationArtefact(event: EventRecord): boolean {
  return event.kind === 'licence' && event.metrics['from'] === 'unidentified';
}

const now = new Date().toISOString();
let withdrawn = 0;

for (const month of listEventMonths()) {
  const events = readEvents(month);
  const superseded = new Set(
    events.map((event) => event.supersedes).filter((id): id is string => id !== null),
  );

  const wrong = events.filter(
    (event) => isMigrationArtefact(event) && !superseded.has(event.id),
  );
  if (wrong.length === 0) continue;

  process.stdout.write(`${month}: ${wrong.length} licence findings to withdraw\n`);
  for (const event of wrong.slice(0, 5)) {
    process.stdout.write(
      `  ${event.repo}: ${String(event.metrics['from'])} → ${String(event.metrics['to'])}\n`,
    );
  }
  if (wrong.length > 5) process.stdout.write(`  … and ${wrong.length - 5} more\n`);

  if (WRITE) {
    appendEvents(
      month,
      wrong.map((event) => ({
        id: `correction:${event.id}`,
        kind: 'correction' as const,
        repo: event.repo,
        detectedAt: now,
        confidence: 'confirmed' as const,
        summaryState: 'skipped' as const,
        summary: null,
        summarySource: null,
        evidenceUrl: event.evidenceUrl,
        metrics: {
          withdrawn: event.kind,
          reason:
            'The licence field was added to the schema after these rows existed, so an absent previous value compared as a change. The licence did not move.',
        },
        supersedes: event.id,
      })),
    );
  }

  withdrawn += wrong.length;
}

if (withdrawn === 0) process.stdout.write('Nothing to withdraw.\n');
else if (!WRITE) process.stdout.write(`\n${withdrawn} total. Pass --write to record them.\n`);
else process.stdout.write(`\n${withdrawn} withdrawn.\n`);
