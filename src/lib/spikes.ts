/**
 * Fork-spike detection.
 *
 * A spike is a public claim about someone else's repository, made to an
 * audience that can check it in ten seconds. The bar is deliberately high and
 * every guard below exists to keep a number off the site rather than to get one
 * onto it.
 *
 * Everything here is pure. No clock, no filesystem, no network — the caller
 * supplies the observation and gets a verdict back, which is what makes the
 * guards testable one at a time.
 */

export interface SpikeThresholds {
  /** Baseline is a trailing mean over this many days of history. */
  baselineWindowDays: number;
  /** Below this much history, collect but do not classify. */
  minBaselineDays: number;
  /**
   * Fork additions required before a multiplier is computed at all.
   *
   * This is the guard against small numbers. One fork becoming twelve is
   * mathematically 12× and editorially meaningless; without a floor, every
   * dormant repository that catches a single mention becomes a headline.
   */
  minAbsoluteIncrease: number;
  /** Multiplier over baseline required to cross the threshold. */
  minMultiplier: number;
  /**
   * Above this, show a bounded label instead of a figure. Precision at that
   * magnitude implies confidence the data does not support.
   */
  displayCap: number;
  /** A window shorter than this is not yet a day and cannot be compared. */
  minWindowHours: number;
}

export const DEFAULT_THRESHOLDS: SpikeThresholds = {
  baselineWindowDays: 30,
  minBaselineDays: 14,
  minAbsoluteIncrease: 25,
  minMultiplier: 3,
  displayCap: 50,
  minWindowHours: 24,
};

/** One row of `history/`, reduced to what the baseline needs. */
export interface DailyForkCount {
  date: string;
  forks: number;
}

export interface SpikeObservation {
  repo: string;
  /** History for this repository, any order. Filtered to the window here. */
  history: readonly DailyForkCount[];
  /** Fork count as of `observedAt`. */
  currentForks: number;
  /** ISO 8601 UTC of the current reading. */
  observedAt: string;
  /** Fork count at the far edge of the rolling window, or null if unavailable. */
  windowStartForks: number | null;
  /** ISO 8601 UTC of that reading. */
  windowStartAt: string | null;
  /**
   * The last date this repository was classified `detected` or `confirmed`.
   * Two-run confirmation reads this: a spike is only confirmed once it has
   * persisted across consecutive daily snapshots.
   */
  previousDetectionDate: string | null;
  /** `YYYY-MM-DD` UTC of the current daily run. */
  today: string;
}

/**
 * `quiet` is a first-class outcome, not a failure. Most repositories on most
 * days are quiet, and saying so is the instrument working correctly.
 */
export type SpikeState = 'forming' | 'quiet' | 'detected' | 'confirmed';

export interface SpikeVerdict {
  repo: string;
  state: SpikeState;
  /** Why this state was reached. Diagnostic, not display copy. */
  reason: string;
  /** Days of usable baseline actually found. */
  baselineDays: number;
  /** Trailing mean of daily fork additions. Null when not computable. */
  baselinePerDay: number | null;
  /** Fork additions across the observation window. */
  delta: number | null;
  /** Real length of the observation window. Never assumed to be 24. */
  windowHours: number | null;
  /** Baseline scaled to the observation window, so both sides span the same time. */
  expectedForWindow: number | null;
  /** delta ÷ expectedForWindow. Infinity when the baseline is zero. */
  multiplier: number | null;
  /** Multiplier for display: bounded by `displayCap`. */
  displayMultiplier: number | null;
  /** True when the real multiplier exceeds the cap and the label is bounded. */
  multiplierCapped: boolean;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

function parseDay(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`spikes: "${date}" is not a YYYY-MM-DD date`);
  return ms;
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / MS_PER_DAY);
}

export interface Baseline {
  /** Mean fork additions per day. Null when there is nothing to average. */
  perDay: number | null;
  /** Days of history the mean covers. */
  days: number;
}

/**
 * Trailing mean of daily fork additions.
 *
 * Differences consecutive snapshots and divides by the real gap between them,
 * so a skipped daily run spreads its additions over the days it covered instead
 * of appearing as one artificial surge.
 *
 * Negative daily additions — forks do get deleted — are clamped to zero. That
 * raises the baseline slightly, which makes the detector harder to trigger.
 * Erring toward silence is the right direction for a public claim.
 */
export function baselineFromHistory(
  history: readonly DailyForkCount[],
  today: string,
  thresholds: SpikeThresholds = DEFAULT_THRESHOLDS,
): Baseline {
  const cutoff = parseDay(today) - thresholds.baselineWindowDays * MS_PER_DAY;

  const window = history
    .filter((row) => parseDay(row.date) >= cutoff)
    .slice()
    .sort((a, b) => parseDay(a.date) - parseDay(b.date));

  if (window.length < 2) return { perDay: null, days: 0 };

  let additions = 0;
  let days = 0;

  for (let i = 1; i < window.length; i += 1) {
    const previous = window[i - 1] as DailyForkCount;
    const current = window[i] as DailyForkCount;
    const gap = daysBetween(previous.date, current.date);
    if (gap <= 0) continue;

    additions += Math.max(0, current.forks - previous.forks);
    days += gap;
  }

  if (days === 0) return { perDay: null, days: 0 };
  return { perDay: additions / days, days };
}

function verdict(base: Partial<SpikeVerdict> & { repo: string; state: SpikeState; reason: string }): SpikeVerdict {
  return {
    baselineDays: 0,
    baselinePerDay: null,
    delta: null,
    windowHours: null,
    expectedForWindow: null,
    multiplier: null,
    displayMultiplier: null,
    multiplierCapped: false,
    ...base,
  };
}

/**
 * Classify one repository.
 *
 * Guards run in order and the first one to fail decides the outcome, so a
 * verdict can always be traced to a single rule.
 */
export function classifySpike(
  observation: SpikeObservation,
  thresholds: SpikeThresholds = DEFAULT_THRESHOLDS,
): SpikeVerdict {
  const { repo, history, currentForks, observedAt, windowStartForks, windowStartAt, today } =
    observation;

  const baseline = baselineFromHistory(history, today, thresholds);

  // 1. Not enough history to know what normal looks like for this repository.
  if (baseline.perDay === null || baseline.days < thresholds.minBaselineDays) {
    return verdict({
      repo,
      state: 'forming',
      reason: `baseline covers ${baseline.days} days, needs ${thresholds.minBaselineDays}`,
      baselineDays: baseline.days,
      baselinePerDay: baseline.perDay,
    });
  }

  // 2. No far edge to measure from yet.
  if (windowStartForks === null || windowStartAt === null) {
    return verdict({
      repo,
      state: 'forming',
      reason: 'no observation window available',
      baselineDays: baseline.days,
      baselinePerDay: baseline.perDay,
    });
  }

  const windowHours = (Date.parse(observedAt) - Date.parse(windowStartAt)) / MS_PER_HOUR;

  if (!Number.isFinite(windowHours) || windowHours < thresholds.minWindowHours) {
    return verdict({
      repo,
      state: 'forming',
      reason: `window spans ${windowHours.toFixed(1)}h, needs ${thresholds.minWindowHours}h`,
      baselineDays: baseline.days,
      baselinePerDay: baseline.perDay,
    });
  }

  const delta = currentForks - windowStartForks;
  const expectedForWindow = (baseline.perDay * windowHours) / 24;

  const measured = {
    baselineDays: baseline.days,
    baselinePerDay: baseline.perDay,
    delta,
    windowHours,
    expectedForWindow,
  };

  // 3. The small-numbers guard. Runs before any multiplier is computed.
  if (delta < thresholds.minAbsoluteIncrease) {
    return verdict({
      repo,
      state: 'quiet',
      reason: `${delta} forks added, floor is ${thresholds.minAbsoluteIncrease}`,
      ...measured,
    });
  }

  const multiplier = expectedForWindow > 0 ? delta / expectedForWindow : Infinity;

  // 4. Above the floor, but not unusual for this repository.
  if (multiplier < thresholds.minMultiplier) {
    return verdict({
      repo,
      state: 'quiet',
      reason: `${multiplier.toFixed(1)}x baseline, threshold is ${thresholds.minMultiplier}x`,
      ...measured,
      multiplier,
      displayMultiplier: multiplier,
    });
  }

  const capped = multiplier > thresholds.displayCap;
  const shared = {
    ...measured,
    multiplier,
    displayMultiplier: capped ? thresholds.displayCap : multiplier,
    multiplierCapped: capped,
  };

  // 5. Two-run confirmation. A single observation is `detected` and gets
  //    neutral treatment; only persistence across consecutive daily snapshots
  //    earns `confirmed`. This is the cheapest defence against fork farms,
  //    which are trivially manufactured with throwaway accounts.
  const previous = observation.previousDetectionDate;
  if (previous !== null) {
    const age = daysBetween(previous, today);
    // One day is the normal case. Two tolerates a skipped daily run without
    // resetting a genuine spike back to square one.
    if (age >= 1 && age <= 2) {
      return verdict({ repo, state: 'confirmed', reason: `persisted since ${previous}`, ...shared });
    }
  }

  return verdict({ repo, state: 'detected', reason: 'threshold crossed on first observation', ...shared });
}

/**
 * Round a multiplier for display.
 *
 * One decimal place, and never dressed up: if the baseline is 45.3 then 45 is
 * fine, but "approximately 50" discards precision that was available.
 */
export function roundMultiplier(value: number): number {
  return Math.round(value * 10) / 10;
}
