import type { AssertExhaustive } from './keys.ts';

/**
 * One incident, as its own provider announced it.
 *
 * Nothing here is judged or scored. A provider publishes an incident feed, this
 * records what was in it, and the only thing added is that the records are kept
 * after the feed drops them — Statuspage feeds carry a few months and then
 * forget, so "how often does this one actually go down" has no answer anywhere
 * a month later.
 */
export interface IncidentRow {
  /** Slug, as this project spells it. Stable across a provider's renames. */
  provider: string;
  /** The feed's own guid, or its link. Deduplicates across runs. */
  id: string;
  title: string;
  /** ISO 8601 UTC, from the feed's pubDate. */
  startedAt: string;
  /**
   * Whether the provider marked it resolved.
   *
   * Read from the update the provider labelled `Resolved`. An unresolved
   * incident is either ongoing or one they never closed out, and this cannot
   * tell those apart — so it says unresolved rather than guessing which.
   */
  resolved: boolean;
  url: string;
}

export const INCIDENT_KEYS = [
  'provider',
  'id',
  'title',
  'startedAt',
  'resolved',
  'url',
] as const satisfies readonly (keyof IncidentRow)[];

export type _IncidentKeysExhaustive = AssertExhaustive<
  Exclude<keyof IncidentRow, (typeof INCIDENT_KEYS)[number]>
>;
