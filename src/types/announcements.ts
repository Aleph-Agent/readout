import type { AssertExhaustive } from './keys.ts';

/**
 * One line of `data/announcements.jsonl` — what has been posted, and where.
 *
 * Kept out of the events file for the same reason summaries are: events are
 * append-only and never rewritten, and an announcement is something that
 * happened to an event afterwards rather than part of the reading.
 *
 * Its real job is to make double-posting impossible. Without it, every run
 * would announce the same finding again.
 */
export interface AnnouncementRecord {
  eventId: string;
  /** `posted` or `failed`. A failure is recorded so it can be retried once. */
  state: 'posted' | 'failed';
  /** Post id from X, or null. */
  postId: string | null;
  /** The exact text sent, so what was claimed publicly stays on the record. */
  text: string | null;
  /** Why it failed, if it did. Never contains a credential. */
  error: string | null;
  announcedAt: string;
}

export const ANNOUNCEMENT_KEYS = [
  'eventId',
  'state',
  'postId',
  'text',
  'error',
  'announcedAt',
] as const satisfies readonly (keyof AnnouncementRecord)[];

export type _AnnouncementKeysExhaustive = AssertExhaustive<
  Exclude<keyof AnnouncementRecord, (typeof ANNOUNCEMENT_KEYS)[number]>
>;
