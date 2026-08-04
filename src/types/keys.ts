/**
 * Compile-time guard shared by every schema in this directory.
 *
 * Each record type declares a `*_KEYS` tuple that drives serialisation. Fields
 * are written in that order and only in that order, because a fixed key order
 * is what keeps `git diff` line-level across thousands of commits.
 *
 * The hazard is that adding a field to a record type without adding it to the
 * tuple makes the field vanish from the ledger — no error, no warning, just
 * missing data noticed weeks later. `AssertExhaustive` turns that into a type
 * error at the definition site.
 *
 * The two directions are enforced separately:
 *   - tuple ⊆ keys   via `satisfies readonly (keyof T)[]` on the tuple
 *   - keys  ⊆ tuple  via `AssertExhaustive<Exclude<keyof T, Tuple[number]>>`
 */
export type AssertExhaustive<T extends never> = T;
