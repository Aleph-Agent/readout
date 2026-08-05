import type { EventKind, EventRecord } from '../types/events.ts';

/**
 * What the reader is told a thing is called, and what its numbers mean.
 *
 * Metric keys were being printed by splitting camelCase, so the page said
 * "ratio To Median 12" and "observation Hours 26". Those are variable names,
 * not measurements: no unit, no comparison group, and a number whose meaning
 * the reader has to reconstruct. Naming them here is the difference between
 * publishing a figure and publishing a reading.
 */

export const SIGNAL_LABEL: Record<EventKind, string> = {
  release: 'Release',
  'fork-spike': 'Fork activity',
  'fork-outlier': 'Fork activity',
  'demand-cluster': 'Demand',
  'dependency-shift': 'Dependency change',
  lineage: 'Lineage',
  correction: 'Correction',
};

/**
 * The comparison each finding rests on, in words.
 *
 * `fork-spike` and `fork-outlier` are different claims resting on different
 * evidence, available at different times, and they were rendering identically.
 * A reader could not tell whether "12×" meant twelve times this project's own
 * history or twelve times the rest of its category, and those are not
 * interchangeable statements.
 */
export const COMPARISON: Partial<Record<EventKind, string>> = {
  'fork-spike': 'measured against this repository’s own trailing baseline',
  'fork-outlier': 'measured against other repositories in its category, the same day',
  'demand-cluster': 'measured across the open issues of the repositories watched here',
  'dependency-shift': 'read from this repository’s dependency manifest',
};

interface MetricLabel {
  label: string;
  /** Appended after the value. Empty where the value carries its own units. */
  unit?: string;
}

const METRICS: Record<string, MetricLabel> = {
  forksAdded: { label: 'Forks added', unit: '' },
  observationHours: { label: 'Measured over', unit: ' hours' },
  baselinePerDay: { label: 'Its usual rate', unit: ' forks/day' },
  baselineDays: { label: 'Baseline built from', unit: ' days' },
  multiplier: { label: 'Times its usual rate', unit: '×' },
  totalForks: { label: 'Forks in total', unit: '' },

  category: { label: 'Category', unit: '' },
  categoryMedian: { label: 'Category median', unit: ' forks' },
  peers: { label: 'Compared against', unit: ' repositories' },
  rankInCategory: { label: 'Rank in category', unit: '' },
  ratioToMedian: { label: 'Times the median', unit: '×' },

  tag: { label: 'Version', unit: '' },
  previousTag: { label: 'Previous version', unit: '' },
  publishedAt: { label: 'Published', unit: '' },
  forks: { label: 'Forks', unit: '' },
  stars: { label: 'Stars', unit: '' },

  term: { label: 'Asked about', unit: '' },
  repositories: { label: 'Across', unit: ' repositories' },
  issues: { label: 'Open issues', unit: '' },
  engagement: { label: 'Reactions and comments', unit: '' },

  manifest: { label: 'Manifest', unit: '' },
  added: { label: 'Dependencies added', unit: '' },
  removed: { label: 'Dependencies removed', unit: '' },
  majorBumps: { label: 'Major version moves', unit: '' },
  addedNames: { label: 'Added', unit: '' },
  removedNames: { label: 'Removed', unit: '' },
  bumpedNames: { label: 'Moved', unit: '' },
};

/**
 * Keys that qualify a claim rather than measure anything.
 *
 * `scope: watchlist` and `multiplierCapped: yes` were rendering as tiles beside
 * real readings, which makes a caveat look like a measurement and a measurement
 * look like a caveat. They are stated in prose instead, or not at all.
 */
const NOT_A_MEASUREMENT = new Set(['scope', 'multiplierCapped', 'ratioCapped', 'withdrawn', 'reason', 'retractedTerm']);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export interface Reading {
  label: string;
  value: string;
}

/** Every metric worth showing, named and carrying its unit. */
export function readingsOf(event: EventRecord): Reading[] {
  const readings: Reading[] = [];

  for (const [key, raw] of Object.entries(event.metrics)) {
    if (raw === null || raw === '') continue;
    if (NOT_A_MEASUREMENT.has(key)) continue;

    const known = METRICS[key];
    // A timestamp is a machine's way of writing a date. Readers want the day.
    const value = ISO_TIMESTAMP.test(String(raw)) ? String(raw).slice(0, 10) : String(raw);

    if (known === undefined) {
      // An unmapped key is shown rather than dropped — losing a measurement is
      // worse than showing one awkwardly — but its shape says it is unmapped.
      readings.push({ label: key.replace(/([A-Z])/g, ' $1').toLowerCase(), value });
      continue;
    }

    readings.push({ label: known.label, value: `${value}${known.unit ?? ''}` });
  }

  return readings;
}

/** A bounded figure has to say it is bounded, wherever it appears. */
export function isCapped(event: EventRecord): boolean {
  return event.metrics['multiplierCapped'] === 'yes' || event.metrics['ratioCapped'] === 'yes';
}
