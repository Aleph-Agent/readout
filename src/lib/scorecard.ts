import type { EventRecord } from '../types/events.ts';

/**
 * The project marking its own homework, in public.
 *
 * Everything else here reports on other people's repositories. This reports on
 * the reports: when a fork spike was confirmed, did anything follow? A product
 * that makes predictions-adjacent claims and never scores itself is asking to
 * be trusted rather than earning it.
 *
 * It is deliberately a weak claim. Fork activity preceding a release is a
 * pattern, not a mechanism, and this measures co-occurrence and says so. The
 * number is published whatever it says — a low rate is information about the
 * detector, which is exactly what a reader deserves to know before believing
 * the next one.
 */

/** How long after a finding a release still counts as having followed it. */
const FOLLOW_WINDOW_DAYS = 7;

/** Below this many resolved findings the rate is noise, not a measurement. */
const MIN_SAMPLE = 10;

export interface Scorecard {
  /** Confirmed fork findings old enough for the window to have closed. */
  resolved: number;
  /** Of those, how many saw a release from the same repository inside it. */
  followed: number;
  /** followed ÷ resolved, or null below the minimum sample. */
  rate: number | null;
  windowDays: number;
  /** Findings too recent to have been resolved yet. Disclosed, not hidden. */
  pending: number;
}

const MS_PER_DAY = 86_400_000;

export function scoreFindings(events: readonly EventRecord[], now: Date): Scorecard {
  const superseded = new Set(
    events.map((event) => event.supersedes).filter((id): id is string => id !== null),
  );

  const releasesByRepo = new Map<string, number[]>();
  for (const event of events) {
    if (event.kind !== 'release') continue;
    const at = Date.parse(event.detectedAt);
    const list = releasesByRepo.get(event.repo);
    if (list) list.push(at);
    else releasesByRepo.set(event.repo, [at]);
  }

  const findings = events.filter(
    (event) =>
      (event.kind === 'fork-spike' || event.kind === 'fork-outlier') &&
      event.confidence === 'confirmed' &&
      // A retracted finding is not scored. Counting a claim the project
      // withdrew, in either direction, would be dishonest arithmetic.
      !superseded.has(event.id),
  );

  const cutoff = now.getTime() - FOLLOW_WINDOW_DAYS * MS_PER_DAY;

  let resolved = 0;
  let followed = 0;
  let pending = 0;

  for (const finding of findings) {
    const at = Date.parse(finding.detectedAt);

    if (at > cutoff) {
      pending += 1;
      continue;
    }

    resolved += 1;
    const releases = releasesByRepo.get(finding.repo) ?? [];
    if (releases.some((r) => r > at && r <= at + FOLLOW_WINDOW_DAYS * MS_PER_DAY)) followed += 1;
  }

  return {
    resolved,
    followed,
    rate: resolved >= MIN_SAMPLE ? followed / resolved : null,
    windowDays: FOLLOW_WINDOW_DAYS,
    pending,
  };
}
