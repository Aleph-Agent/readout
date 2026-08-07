import type { EventRecord } from '../types/events.ts';

/**
 * What the release record says once there is enough of it to say anything.
 *
 * Two readings, both derived from events already on disk and neither costing a
 * request. They answer questions a release feed cannot: not "what shipped" but
 * "what stopped shipping", and not "there is a new version" but "that version
 * is going to break something".
 */

// ------------------------------------------------------------------- cadence

export interface CadenceReading {
  repo: string;
  /** Days between releases, typical. Median, so one long gap cannot set it. */
  medianGap: number;
  /** Days since the newest release on record. */
  sinceLast: number;
  /** `sinceLast` over `medianGap`, to one decimal. */
  overdue: number;
  releases: number;
  lastTag: string | null;
  lastAt: string;
}

export interface CadenceSummary {
  /** Repositories with enough releases on record to have a rhythm at all. */
  measured: number;
  /** Repositories with releases on record but too few to compare. */
  forming: number;
  /** Past `OVERDUE_AT` times their own median. Most overdue first. */
  overdue: CadenceReading[];
}

/**
 * Releases needed before a rhythm is a rhythm.
 *
 * Four releases give three gaps, which is the fewest a median can be taken over
 * without one unusual month deciding the answer. Below that the honest report
 * is that nothing is known yet.
 */
export const MIN_RELEASES = 4;

/** How far past its own median a project has to be before it is worth saying. */
export const OVERDUE_AT = 2.5;

/** Never claim a rhythm from a project that releases twice a decade. */
export const MAX_MEDIAN_GAP = 180;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

export function summariseCadence(
  events: readonly EventRecord[],
  today: string,
): CadenceSummary {
  const byRepo = new Map<string, EventRecord[]>();
  for (const event of events) {
    if (event.kind !== 'release') continue;
    const list = byRepo.get(event.repo);
    if (list) list.push(event);
    else byRepo.set(event.repo, [event]);
  }

  const now = Date.parse(`${today}T00:00:00Z`);
  const overdue: CadenceReading[] = [];
  let measured = 0;
  let forming = 0;

  for (const [repo, releases] of byRepo) {
    if (releases.length < MIN_RELEASES) {
      forming += 1;
      continue;
    }

    const times = releases
      .map((event) => Date.parse(event.detectedAt))
      .filter((at) => Number.isFinite(at))
      .sort((a, b) => a - b);

    const gaps: number[] = [];
    for (let i = 1; i < times.length; i += 1) {
      gaps.push(((times[i] as number) - (times[i - 1] as number)) / 86_400_000);
    }
    if (gaps.length === 0) {
      forming += 1;
      continue;
    }

    const medianGap = median(gaps);
    // A project that releases twice a decade has no rhythm to be late against,
    // and dividing by a huge median produces a ratio that means nothing.
    if (medianGap <= 0 || medianGap > MAX_MEDIAN_GAP) {
      forming += 1;
      continue;
    }

    measured += 1;

    const last = times[times.length - 1] as number;
    const sinceLast = Math.round((now - last) / 86_400_000);
    const ratio = Math.round((sinceLast / medianGap) * 10) / 10;
    if (ratio < OVERDUE_AT) continue;

    const newest = releases.reduce((latest, event) =>
      event.detectedAt > latest.detectedAt ? event : latest,
    );

    overdue.push({
      repo,
      medianGap: Math.round(medianGap * 10) / 10,
      sinceLast,
      overdue: ratio,
      releases: releases.length,
      lastTag: typeof newest.metrics['tag'] === 'string' ? newest.metrics['tag'] : null,
      lastAt: newest.detectedAt.slice(0, 10),
    });
  }

  return {
    measured,
    forming,
    overdue: overdue.sort((a, b) => b.overdue - a.overdue).slice(0, 15),
  };
}

// ----------------------------------------------------------- breaking change

export interface MajorBump {
  repo: string;
  from: string;
  to: string;
  at: string;
  url: string;
}

export interface BreakingSummary {
  /** Releases with both a version and a previous version to compare. */
  compared: number;
  /** Of those, how many crossed a major boundary. */
  major: number;
  /** Newest first. Bounded — see `MAJOR_LIMIT`. */
  bumps: MajorBump[];
}

export const MAJOR_LIMIT = 20;

/**
 * The leading number of a version, or null when there is not one.
 *
 * Deliberately strict. `v2.1.0`, `2.1.0` and `2.1` all read as 2; a calendar
 * version like `2026.08.1` reads as 2026 and is excluded by the caller, because
 * every January would otherwise look like the whole corpus breaking at once.
 */
export function majorOf(tag: string): number | null {
  const match = /^v?(\d+)\./.exec(tag.trim());
  if (match === null) return null;
  const value = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(value) ? value : null;
}

/** A leading number this large is a year, not a major version. */
export const CALENDAR_FROM = 2000;

export function summariseBreaking(events: readonly EventRecord[]): BreakingSummary {
  const bumps: MajorBump[] = [];
  let compared = 0;

  for (const event of events) {
    if (event.kind !== 'release') continue;

    const tag = event.metrics['tag'];
    const previous = event.metrics['previousTag'];
    if (typeof tag !== 'string' || typeof previous !== 'string') continue;

    const to = majorOf(tag);
    const from = majorOf(previous);
    if (to === null || from === null) continue;
    // Calendar versioning is not semantic versioning wearing a hat. A project
    // on 2026.08 bumps its leading number every January, and reporting that as
    // a breaking change would fill this page with nothing every new year.
    if (to >= CALENDAR_FROM || from >= CALENDAR_FROM) continue;

    compared += 1;
    if (to <= from) continue;

    bumps.push({
      repo: event.repo,
      from: previous,
      to: tag,
      at: event.detectedAt.slice(0, 10),
      url: event.evidenceUrl,
    });
  }

  return {
    compared,
    major: bumps.length,
    bumps: bumps.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MAJOR_LIMIT),
  };
}
