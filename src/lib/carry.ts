/**
 * Refuse a write that would lose most of what is already recorded.
 *
 * Eight collectors guard their ledger with `rows.length === 0 ? held : rows`.
 * That catches a total failure and nothing else. If 300 of 388 reads are
 * refused and 88 succeed, the count is 88, the guard passes, and 300 rows are
 * deleted — and the site then reports, in its own voice, that it watches 88
 * packages. The figure is wrong, the page renders, and no error is raised
 * anywhere, because from the collector's point of view 88 successful reads is a
 * successful run.
 *
 * Partial outages are the normal shape of failure for the services this reads:
 * a registry rate-limits, a status feed times out, a batch endpoint refuses
 * half its queries. Total silence is the rare case, and it is the only one the
 * old guard covered.
 *
 * So the rule here is about proportion rather than emptiness. A collector may
 * shrink; it may not collapse. Anything that would drop more than half the
 * ledger in one run is treated as an outage, the previous rows stand, and the
 * run says so — because a reading that is a day old and labelled as such is
 * worth more than a fresh reading of a fraction of the subject.
 */

/**
 * How much of a ledger a single run may remove.
 *
 * Half. A watchlist entry retired by commit, a package that stopped publishing,
 * a product cycle that ended — those move a ledger by a few rows. Nothing in
 * this project legitimately halves one overnight, so anything that does is a
 * service having a bad day.
 *
 * When a genuine halving is intended, it arrives as a reviewed commit that
 * changes the watchlist, and the run after it carries the smaller set forward
 * from a ledger that was already small.
 */
export const MIN_SHARE = 0.5;

export interface CarryResult<T> {
  /** What to write. Either the fresh reading or the one already on disk. */
  rows: readonly T[];
  /** Null when the fresh reading was taken. A sentence for the run report otherwise. */
  error: string | null;
  /** True when the previous rows were kept. Useful to a caller that counts. */
  carried: boolean;
}

/**
 * Decide what a collector is allowed to write.
 *
 * `label` names the collector in the error, because a run report saying
 * "carried forward" without saying what is a run report nobody can act on.
 */
export function keepOrCarry<T>(
  label: string,
  fresh: readonly T[],
  held: readonly T[],
): CarryResult<T> {
  // Nothing recorded yet. The first run has nothing to protect and every
  // reading, however partial, is an improvement on an empty file.
  if (held.length === 0) return { rows: fresh, error: null, carried: false };

  if (fresh.length === 0) {
    return {
      rows: held,
      error: `${label}: read nothing this run, ${held.length} rows carried forward`,
      carried: true,
    };
  }

  if (fresh.length < held.length * MIN_SHARE) {
    return {
      rows: held,
      error:
        `${label}: read ${fresh.length} of ${held.length} rows, which is below half — ` +
        'treated as a partial outage and the previous reading carried forward',
      carried: true,
    };
  }

  return { rows: fresh, error: null, carried: false };
}
