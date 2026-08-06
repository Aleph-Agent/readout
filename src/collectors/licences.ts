/**
 * Relicensing, and going read-only.
 *
 * The only two signals here that need no threshold and have no false-positive
 * mode: a field either changed between two readings or it did not. Everything
 * else in this project is a judgement about magnitude that can be set wrong —
 * and four of five detectors currently sit above anything that happens.
 *
 * Both fields arrive in the repository payload the pulse already pays for six
 * times a day, and both were discarded until now. The marginal cost of this
 * collector is zero requests.
 *
 * Relicensing is rare and consequential in a way nothing else here matches.
 * HashiCorp, Redis, Elastic, MongoDB, Sentry and Terraform each moved off an
 * open licence; each time it dominated developer discussion for weeks and
 * forked the project. Nobody aggregates it.
 *
 * Pure. The diff is the whole collector.
 */

import { eventId } from '../lib/ledger.ts';
import type { EventRecord } from '../types/events.ts';
import type { LiveStateRow } from '../types/state.ts';

export interface LicenceCollectionOptions {
  /** ISO 8601 UTC of this run. */
  now: string;
  /** `YYYY-MM-DD` UTC of this run. */
  today: string;
  seen: ReadonlySet<string>;
}

/**
 * Compare this pulse's rows against the last.
 *
 * A repository with no previous row produces nothing: a first reading is a
 * starting point, not a change, and reporting one would announce every licence
 * on the watchlist as news on the day the field was added.
 */
export function collectLicences(
  rows: readonly LiveStateRow[],
  previous: ReadonlyMap<string, LiveStateRow>,
  options: LicenceCollectionOptions,
): EventRecord[] {
  const events: EventRecord[] = [];

  for (const row of rows) {
    const before = previous.get(row.id);
    if (before === undefined) continue;

    // A field that is absent from the previous row is not a previous value.
    //
    // `license` and `archived` were added to the schema after 400 state rows
    // already existed, and `conform` fills a missing key with undefined. The
    // first version compared against that and published 207 licence changes in
    // one run — every repository on the watchlist appearing to relicense from
    // "unidentified" to whatever it had always been. All 207 were retracted.
    //
    // undefined means never recorded and is not comparable. null means recorded
    // and GitHub could not identify one, which is a real value and a real
    // transition when it changes.
    if (before.license !== undefined && before.license !== row.license) {
      // Null on either side is "GitHub could not identify one", which is a real
      // transition worth reporting and is worded as what it is rather than as a
      // licence named "none".
      const id = eventId('licence', row.id, options.today);
      if (!options.seen.has(id)) {
        events.push({
          id,
          kind: 'licence',
          repo: row.id,
          detectedAt: options.now,
          // Confirmed on sight. There is no second observation that could make
          // a changed field more true, and the two-run rule exists for counts
          // that can be manufactured — this cannot.
          confidence: 'confirmed',
          // The template states the whole fact. A model could only add risk.
          summaryState: 'skipped',
          summary: null,
          summarySource: null,
          evidenceUrl: `https://github.com/${row.id}`,
          metrics: {
            from: before.license ?? 'unidentified',
            to: row.license ?? 'unidentified',
          },
          supersedes: null,
        });
      }
    }

    if (before.archived !== undefined && !before.archived && row.archived) {
      const id = eventId('archived', row.id, options.today);
      if (!options.seen.has(id)) {
        events.push({
          id,
          kind: 'archived',
          repo: row.id,
          detectedAt: options.now,
          confidence: 'confirmed',
          summaryState: 'skipped',
          summary: null,
          summarySource: null,
          evidenceUrl: `https://github.com/${row.id}`,
          metrics: { archived: 'yes' },
          supersedes: null,
        });
      }
    }
  }

  return events;
}
