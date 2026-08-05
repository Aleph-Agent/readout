import type { AssertExhaustive } from './keys.ts';

/**
 * One line of `data/lineage-roots.jsonl` — a model whose descendants are
 * watched, and how far we have read.
 *
 * Curated for the same reason the repository watchlist is: which models matter
 * enough to trace descent from is an editorial claim, and deriving it by
 * popularity would surface whatever was uploaded most, not what people build
 * on. Changes are reviewed commits.
 */
export interface LineageRoot {
  /** `owner/model` on Hugging Face. */
  id: string;
  /** Repository on the watchlist this model belongs to, or null. */
  repo: string | null;
  added: string;
  active: boolean;
  /**
   * Creation timestamp of the newest descendant already counted.
   *
   * Everything at or before this has been seen. Null means the root has never
   * been read, and the first read records the mark without reporting anything —
   * otherwise every model ever built on it would arrive at once as this week's
   * news.
   */
  seenThrough: string | null;
  /** Descendants counted since watching began. Cumulative, never reset. */
  descendants: number;
}

export const LINEAGE_ROOT_KEYS = [
  'id',
  'repo',
  'added',
  'active',
  'seenThrough',
  'descendants',
] as const satisfies readonly (keyof LineageRoot)[];

export type _LineageRootKeysExhaustive = AssertExhaustive<
  Exclude<keyof LineageRoot, (typeof LINEAGE_ROOT_KEYS)[number]>
>;
