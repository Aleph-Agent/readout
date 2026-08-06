/**
 * Where attention and use disagree.
 *
 * Stars measure attention. Weekly installs measure use. They are different
 * questions and they are routinely treated as the same one, which is how a
 * project with forty thousand stars and no users gets picked over one with
 * eight thousand stars and a hundred and fifty million weekly installs.
 *
 * Both figures are already collected. Nobody publishes the comparison because
 * nobody joins the two sources, and that is the whole of the moat: it is not
 * difficult, it is just not done.
 *
 * This states a disagreement between two measurements. It does not rank, does
 * not judge, and never says which number is the right one to care about.
 *
 * The honesty problem is real and is handled with a floor. A package with
 * ninety-one weekly installs is almost never unused — it is distributed
 * somewhere this project does not read. faiss ships as `faiss-cpu`, kibana is
 * not installed through npm at all, and reporting either as "ignored" would be
 * a confident lie. Below the floor the comparison is not made.
 */

/** Below this, a low install count means "not distributed here", not "unused". */
export const MIN_INSTALLS = 10_000;

/** Below this a star count is noise and the ratio swings on nothing. */
export const MIN_STARS = 500;

/** How many to show at each end. Enough to be a reading, not a directory. */
const SHOWN = 8;

export interface DivergenceInput {
  id: string;
  name: string;
  stars: number;
  installs: number | null;
}

export interface DivergenceRow {
  repo: string;
  stars: number;
  installs: number;
  /** Weekly installs per star. The comparison, stated as one number. */
  perStar: number;
}

export interface DivergenceSummary {
  /** Repositories where both figures clear their floor. The sample. */
  compared: number;
  /** Median installs per star across the sample, for context on either list. */
  median: number | null;
  /** Most installs per star: used far more than it is watched. */
  used: DivergenceRow[];
  /** Fewest: watched far more than it is used, through this registry. */
  watched: DivergenceRow[];
}

export function summariseDivergence(rows: readonly DivergenceInput[]): DivergenceSummary {
  const eligible = rows
    .filter(
      (row): row is DivergenceInput & { installs: number } =>
        row.installs !== null && row.installs >= MIN_INSTALLS && row.stars >= MIN_STARS,
    )
    .map(
      (row): DivergenceRow => ({
        repo: row.name,
        stars: row.stars,
        installs: row.installs,
        // Rounded to two places: below one install per star the interesting
        // part is the order of magnitude, not the digits.
        perStar: Math.round((row.installs / row.stars) * 100) / 100,
      }),
    );

  if (eligible.length === 0) {
    return { compared: 0, median: null, used: [], watched: [] };
  }

  // Ties broken by name so the bundle is byte-identical for identical input.
  const byRatio = [...eligible].sort(
    (a, b) => a.perStar - b.perStar || (a.repo < b.repo ? -1 : 1),
  );
  const middle = byRatio[Math.floor(byRatio.length / 2)] as DivergenceRow;

  return {
    compared: eligible.length,
    median: middle.perStar,
    used: [...byRatio].reverse().slice(0, SHOWN),
    watched: byRatio.slice(0, SHOWN),
  };
}
