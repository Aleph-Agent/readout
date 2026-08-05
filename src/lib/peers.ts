/**
 * Peer-relative fork activity.
 *
 * The self-relative detector in `spikes.ts` cannot say anything for fourteen
 * days, because it compares a repository against its own history and there is
 * none yet. But four hundred repositories are measured on the same day, so a
 * second comparison is available after a single window: how does this
 * repository's day compare to the other repositories in its category?
 *
 * These are different claims and are kept apart deliberately. "27× its own
 * 30-day baseline" and "eight times the median project in its category today"
 * are not interchangeable, and conflating them would let the site imply history
 * it does not have. They travel as separate event kinds with separate wording.
 *
 * Pure. Same reason as spikes: every guard has to be testable on its own.
 */

export interface PeerObservation {
  id: string;
  /** Editorial grouping from the watchlist. */
  category: string;
  /** Fork additions across the observation window. */
  delta: number;
  /** Real length of that window. Never assumed to be 24. */
  windowHours: number;
}

export interface PeerThresholds {
  /** A category needs enough members before a median means anything. */
  minPeers: number;
  /**
   * The same small-numbers guard as spikes, and it matters more here: most
   * repositories add no forks on a given day, so a category median is often
   * zero and any activity at all divides to infinity.
   */
  minAbsoluteIncrease: number;
  /**
   * Times the category median. Set well above the self-relative threshold
   * because category medians are low and noisy.
   */
  minRatio: number;
  /**
   * Only the busiest few in a category can qualify on a given day. This is what
   * bounds output: five categories at three each is fifteen findings a day,
   * which is the order of magnitude the project budgets for.
   */
  maxRank: number;
  displayCap: number;
  /** A window shorter than this is not yet a day and cannot be compared. */
  minWindowHours: number;
}

export const DEFAULT_PEER_THRESHOLDS: PeerThresholds = {
  minPeers: 20,
  minAbsoluteIncrease: 25,
  minRatio: 8,
  maxRank: 3,
  displayCap: 50,
  minWindowHours: 24,
};

export type PeerState =
  /** Not enough comparable repositories, or the window has not filled. */
  | 'insufficient'
  /** Measured, and ordinary for its category. The usual answer. */
  | 'quiet'
  /** Measured, and well above the rest of its category today. */
  | 'outlier';

export interface PeerVerdict {
  id: string;
  category: string;
  state: PeerState;
  reason: string;
  delta: number;
  windowHours: number;
  /** Repositories in the category with a measurable window. */
  peers: number;
  /** Median fork additions across those peers. Reported even when zero. */
  median: number | null;
  /** Position within the category by additions, 1 being the busiest. */
  rank: number | null;
  /** delta ÷ max(median, 1). The floor prevents a zero median exploding it. */
  ratio: number | null;
  displayRatio: number | null;
  ratioCapped: boolean;
}

/** Lower median of an even-length sample: reports a value that was observed. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

function verdict(base: Partial<PeerVerdict> & Pick<PeerVerdict, 'id' | 'category' | 'state' | 'reason' | 'delta' | 'windowHours'>): PeerVerdict {
  return {
    peers: 0,
    median: null,
    rank: null,
    ratio: null,
    displayRatio: null,
    ratioCapped: false,
    ...base,
  };
}

/**
 * Classify every observation against its own category.
 *
 * Returns a verdict for all of them, including the quiet ones. A caller that
 * only wants findings filters for `outlier`; a caller drawing the strip wants
 * the whole distribution.
 */
export function classifyPeers(
  observations: readonly PeerObservation[],
  thresholds: PeerThresholds = DEFAULT_PEER_THRESHOLDS,
): PeerVerdict[] {
  const byCategory = new Map<string, PeerObservation[]>();
  for (const observation of observations) {
    const list = byCategory.get(observation.category);
    if (list) list.push(observation);
    else byCategory.set(observation.category, [observation]);
  }

  const verdicts: PeerVerdict[] = [];

  for (const [category, all] of byCategory) {
    // Only repositories with a real window contribute to the median. Including
    // the ones that have not been measured yet would drag it toward zero and
    // manufacture outliers out of ordinary activity.
    const measured = all.filter((o) => o.windowHours >= thresholds.minWindowHours);

    for (const observation of all.filter((o) => o.windowHours < thresholds.minWindowHours)) {
      verdicts.push(
        verdict({
          ...observation,
          state: 'insufficient',
          reason: `window spans ${observation.windowHours.toFixed(1)}h, needs ${thresholds.minWindowHours}h`,
          peers: measured.length,
        }),
      );
    }

    if (measured.length < thresholds.minPeers) {
      for (const observation of measured) {
        verdicts.push(
          verdict({
            ...observation,
            state: 'insufficient',
            reason: `${measured.length} comparable repositories in ${category}, needs ${thresholds.minPeers}`,
            peers: measured.length,
          }),
        );
      }
      continue;
    }

    const median = medianOf(measured.map((o) => o.delta)) as number;
    const ranked = [...measured].sort((a, b) => b.delta - a.delta || (a.id < b.id ? -1 : 1));

    for (const [index, observation] of ranked.entries()) {
      const rank = index + 1;
      const ratio = observation.delta / Math.max(median, 1);
      const shared = { peers: measured.length, median, rank, ratio };

      if (observation.delta < thresholds.minAbsoluteIncrease) {
        verdicts.push(
          verdict({
            ...observation,
            state: 'quiet',
            reason: `${observation.delta} forks added, floor is ${thresholds.minAbsoluteIncrease}`,
            ...shared,
            ratio: null,
          }),
        );
        continue;
      }

      if (rank > thresholds.maxRank) {
        verdicts.push(
          verdict({
            ...observation,
            state: 'quiet',
            reason: `rank ${rank} in ${category}, only the top ${thresholds.maxRank} qualify`,
            ...shared,
          }),
        );
        continue;
      }

      if (ratio < thresholds.minRatio) {
        verdicts.push(
          verdict({
            ...observation,
            state: 'quiet',
            reason: `${ratio.toFixed(1)}x the ${category} median, threshold is ${thresholds.minRatio}x`,
            ...shared,
            displayRatio: ratio,
          }),
        );
        continue;
      }

      const capped = ratio > thresholds.displayCap;
      verdicts.push(
        verdict({
          ...observation,
          state: 'outlier',
          reason: `rank ${rank} of ${measured.length} in ${category}`,
          ...shared,
          displayRatio: capped ? thresholds.displayCap : ratio,
          ratioCapped: capped,
        }),
      );
    }
  }

  return verdicts;
}
