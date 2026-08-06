/**
 * Comparing a field against its previous reading.
 *
 * This exists because the same mistake was made twice and cost 232 published
 * findings. `license` and `archived` were added to the state schema after 400
 * rows already existed; `conform` fills a missing key with undefined; the
 * collector compared against that and announced a change for every repository
 * on the watchlist.
 *
 * The rule is one line and it is easy to forget, which is exactly why it should
 * not live in each collector's head:
 *
 *   undefined  never recorded — not comparable, say nothing
 *   null       recorded, and the value is absent — comparable
 *
 * A schema addition does not land on every row in one run either. The artefact
 * comes back for as long as any row predates the field, which is why the first
 * retraction missed 25 rows that a later pulse then produced.
 */

export type Changed<T> = { from: T; to: T } | null;

/**
 * The transition between two readings, or null when there is nothing to
 * compare or nothing changed.
 *
 * Pass the previous row's field directly. A row that does not exist at all
 * should be filtered before this — a first reading of a repository is a
 * starting point, not a change.
 */
export function changed<T>(before: T | undefined, after: T): Changed<T> {
  if (before === undefined) return null;
  if (before === after) return null;
  return { from: before, to: after };
}

/**
 * A false-to-true transition on a flag, guarded the same way.
 *
 * `!before.archived` reads as true for a row that predates the field, so the
 * plain negation announces every archived repository the day the field is
 * added.
 */
export function became(before: boolean | undefined, after: boolean): boolean {
  return before !== undefined && !before && after;
}
