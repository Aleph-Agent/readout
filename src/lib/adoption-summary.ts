/**
 * Adoption, reduced to what the page needs.
 *
 * Pure, so the one arithmetic decision here — which windows may be added
 * together — is testable rather than buried in the build.
 */

import type { AdoptionReading, AdoptionSummary } from '../types/bundles.ts';
import type { AdoptionRow } from '../types/adoption.ts';

/** Enough to fill a screen and stop well short of a directory. */
const TOP = 24;

/**
 * Registries whose counts cover the same period and may therefore be summed.
 *
 * npm and PyPI both report a rolling week. Homebrew reports thirty days and
 * crates.io ninety, and adding those to a weekly figure produces a number that
 * measures nothing — it is not a week, not a month, and not comparable to
 * either. They appear in the table with their own windows and nowhere else.
 */
const WEEKLY: ReadonlySet<string> = new Set(['npm', 'pypi']);

export function summariseAdoption(rows: readonly AdoptionRow[]): AdoptionSummary {
  const read = rows.filter((row): row is AdoptionRow & { count: number } => row.count !== null);
  const weeklyRows = read.filter((row) => WEEKLY.has(row.registry));

  const top: AdoptionReading[] = [...read]
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1))
    .slice(0, TOP)
    .map((row) => ({
      repo: row.id,
      registry: row.registry,
      name: row.name,
      count: row.count,
      window: row.window,
    }));

  return {
    measured: read.length,
    unread: rows.length - read.length,
    weekly: weeklyRows.reduce((total, row) => total + row.count, 0),
    weeklyPackages: weeklyRows.length,
    top,
  };
}
