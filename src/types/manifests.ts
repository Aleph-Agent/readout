import type { AssertExhaustive } from './keys.ts';

/**
 * One line of `data/live/manifests.jsonl` — the dependency set last seen for a
 * repository, so the next run can diff against it.
 *
 * Overwritten each daily run and sorted by repository id, like live state. A
 * repository whose dependencies did not move produces no diff at all.
 */
export interface ManifestRow {
  id: string;
  /** Repository-relative path that was read, or null if none was found. */
  path: string | null;
  /** Dependency name to version string, exactly as the manifest spells it. */
  deps: Record<string, string>;
  /** ETag for the contents request, so an unchanged manifest costs nothing. */
  etag: string | null;
  /** `YYYY-MM-DD` of the last successful read. */
  readAt: string | null;
}

export const MANIFEST_KEYS = [
  'id',
  'path',
  'deps',
  'etag',
  'readAt',
] as const satisfies readonly (keyof ManifestRow)[];

export type _ManifestKeysExhaustive = AssertExhaustive<
  Exclude<keyof ManifestRow, (typeof MANIFEST_KEYS)[number]>
>;
