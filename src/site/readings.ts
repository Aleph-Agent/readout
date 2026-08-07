import type { IndexBundle } from '../types/bundles.ts';

/**
 * Every reading, and the question it answers.
 *
 * The navigation used to be fifteen one-word labels in a row — Live, Ships,
 * Forks, Demand, Stack, Lineage, Your stack, Models, Status, Ecosystem,
 * Findings, This week, Depended on, Compare, Method. Each one is exact once you
 * know the product and meaningless before that, and a first-time reader could
 * not tell which of them were measurements, which were tools, or where to
 * start. Fifteen equally-weighted choices is the same as no navigation.
 *
 * This is the list that fixes it, and it is one table rather than fifteen
 * links: what the reading is called, the question it answers, and how much of
 * it there is right now. A reader who has never seen this site should be able
 * to read one screen and know what the whole thing measures.
 *
 * The question, not the noun, is what makes each row legible. "Forks" tells you
 * nothing. "What is being copied faster than it usually is?" tells you whether
 * you care.
 *
 * Counts come from the published bundle, so a reading with nothing in it says
 * zero rather than being quietly hidden. A channel list that only shows the
 * channels currently carrying signal is a channel list that lies about the
 * instrument.
 */
export interface Reading {
  href: string;
  label: string;
  /** What a reader gets from it, phrased as the question they arrived with. */
  question: string;
  /** How much there is, and what the number counts. Null when it does not count. */
  measure: (index: IndexBundle) => { value: number; unit: string } | null;
}

export const READINGS: readonly Reading[] = [
  {
    href: '/live',
    label: 'Live',
    question: 'What changed in the last few hours?',
    measure: (index) => ({ value: index.today.length, unit: 'today' }),
  },
  {
    href: '/ships',
    label: 'Ships',
    question: 'What released a new version?',
    measure: (index) => ({ value: index.lenses.ships.count, unit: 'releases' }),
  },
  {
    href: '/forks',
    label: 'Forks',
    question: 'What is being copied faster than it usually is?',
    measure: (index) => ({ value: index.lenses.forks.count, unit: 'spikes' }),
  },
  {
    href: '/demand',
    label: 'Demand',
    question: 'What are developers asking for in more than one place?',
    measure: (index) => ({ value: index.lenses.demand.count, unit: 'requests' }),
  },
  {
    href: '/stack',
    label: 'Dependencies',
    question: 'What is being added, dropped, or jumped a major version?',
    measure: (index) => ({ value: index.lenses.stack.count, unit: 'shifts' }),
  },
  {
    href: '/lineage',
    label: 'Lineage',
    question: 'Which models say they were built on which?',
    measure: (index) => ({ value: index.lenses.lineage.count, unit: 'claims' }),
  },
  {
    href: '/models',
    label: 'Model prices',
    question: 'What does a million tokens cost, and when did that change?',
    measure: (index) => ({ value: index.models.available, unit: 'models' }),
  },
  {
    href: '/incidents',
    label: 'Outages',
    question: 'Does the thing I depend on go down, and how often?',
    measure: (index) => ({ value: index.incidents.total, unit: 'incidents kept' }),
  },
  {
    href: '/ecosystem',
    label: 'Ecosystem',
    question: 'What do the registries, advisories and forums say, away from GitHub?',
    measure: (index) => ({ value: index.adoption.measured, unit: 'packages' }),
  },
  {
    href: '/depends',
    label: 'Depended on',
    question: 'What does everything else quietly rely on?',
    measure: (index) => ({ value: index.staleness.measured, unit: 'packages read' }),
  },
  {
    href: '/week',
    label: 'This week',
    question: 'What would I have missed if I looked once a week?',
    measure: () => null,
  },
];

/**
 * The four doors.
 *
 * Grouped by what a reader wants rather than by what a collector produces,
 * which is the reason the old list was unreadable: it was an inventory of the
 * software's parts presented as a menu.
 *
 * `Findings` first on purpose. Somebody arriving wants to be told something, not
 * handed an instrument — and if the first thing they see is a claim with a
 * figure attached, everything behind it has a reason to exist.
 */
export const DOORS: readonly { href: string; label: string; matches: readonly string[] }[] = [
  { href: '/findings', label: 'Findings', matches: ['/findings', '/week'] },
  {
    href: '/readings',
    label: 'Readings',
    matches: [
      '/readings',
      '/live',
      '/ships',
      '/forks',
      '/demand',
      '/lineage',
      '/models',
      '/incidents',
      '/ecosystem',
      '/depends',
    ],
  },
  { href: '/stack', label: 'Your stack', matches: ['/stack', '/account', '/compare'] },
  { href: '/method', label: 'Method', matches: ['/method'] },
];

/** Which door a path sits behind, so the bar can mark it. */
export function doorFor(path: string): string | null {
  for (const door of DOORS) {
    if (door.matches.some((match) => path === match || path.startsWith(`${match}/`))) {
      return door.href;
    }
  }
  // A repository page or an event page belongs to the readings.
  if (path.startsWith('/repo/') || path.startsWith('/e/')) return '/readings';
  return null;
}
