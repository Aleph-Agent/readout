/**
 * What the watchlist is actually pointed at.
 *
 * The category has been in the ledger since Prompt 1 and drives peer-relative
 * classification, but it has never been shown. "388 repositories" is a number a
 * reader cannot picture: 388 of what, chosen how, and is the thing they care
 * about anywhere in it. This turns that one number into five rows that answer
 * it, from data already being collected.
 *
 * Pure, so every threshold and every edge — an empty category, a category with
 * nothing measurable yet — is testable without a build.
 */

import type { CoverageRow, StripMark } from '../types/bundles.ts';
import type { EventRecord } from '../types/events.ts';
import type { WatchlistEntry } from '../types/watchlist.ts';

interface Accumulator {
  repositories: number;
  measured: number;
  forksAdded: number;
  findings: number;
  busiest: string | null;
  busiestDelta: number;
}

function empty(): Accumulator {
  return {
    repositories: 0,
    measured: 0,
    forksAdded: 0,
    findings: 0,
    busiest: null,
    busiestDelta: -1,
  };
}

export function buildCoverage(
  watchlist: readonly WatchlistEntry[],
  strip: readonly StripMark[],
  events: readonly EventRecord[],
): CoverageRow[] {
  // Every entry, not only the active ones. A finding for a repository retired
  // last week still happened, and dropping it would quietly shrink the totals
  // the site has already published.
  const categoryOf = new Map(watchlist.map((entry) => [entry.id, entry.category as string]));

  const rows = new Map<string, Accumulator>();

  // Seeded from active entries alone, so the count in the first column is what
  // is being read now rather than what has ever been read.
  for (const entry of watchlist) {
    if (!entry.active) continue;
    const row = rows.get(entry.category) ?? empty();
    row.repositories += 1;
    rows.set(entry.category, row);
  }

  for (const mark of strip) {
    const category = categoryOf.get(mark.id);
    if (category === undefined) continue;
    const row = rows.get(category);
    // A mark with no active entry behind it is a retired repository still
    // carrying a state row. It contributes nothing to a coverage figure.
    if (row === undefined || mark.delta === null) continue;

    row.measured += 1;
    row.forksAdded += mark.delta;
    if (mark.delta > row.busiestDelta) {
      row.busiestDelta = mark.delta;
      row.busiest = mark.name;
    }
  }

  for (const event of events) {
    const category = categoryOf.get(event.repo);
    if (category === undefined) continue;
    const row = rows.get(category);
    if (row === undefined) continue;
    row.findings += 1;
  }

  // Alphabetical, deliberately. Sorting by size would rank the categories, and
  // a ranking is a claim — that one area matters more — which nothing here
  // measures. Alphabetical is also stable, which keeps the bundle's git diff
  // to the lines that actually changed.
  return [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([category, row]) => ({
      category,
      repositories: row.repositories,
      measured: row.measured,
      // Zero measured repositories means no reading, which is not the same
      // claim as a reading of zero and must not be rendered as one.
      forksAdded: row.measured === 0 ? null : row.forksAdded,
      findings: row.findings,
      busiest: row.busiest,
    }));
}
