import { readAllEvents, readAnnouncements, writeAnnouncements } from '../lib/ledger.ts';
import { templatedSentence } from '../lib/validate.ts';
import { createXClient, postLength, MAX_POST_LENGTH, type XClient } from '../lib/x.ts';
import { eventPath } from '../site/event.ts';
import { SITE_ORIGIN } from '../site/render.ts';
import type { EventRecord } from '../types/events.ts';

/**
 * The agent announces its own findings.
 *
 * This is the distribution mechanism. Nobody has to remember to post, and a
 * competitor cannot copy it without also building the instrument behind it.
 *
 * Only `confirmed` findings are eligible. That is the rule the whole confidence
 * ladder exists to serve: a detection that evaporates tomorrow must never have
 * left the site, and a post is the one thing that cannot be taken back.
 */

/** Kept low deliberately. A feed that posts fifteen times an hour is noise. */
const DEFAULT_POSTS_PER_RUN = 4;

export interface AnnounceOptions {
  client?: XClient;
  now?: Date;
  limit?: number;
}

export interface AnnounceResult {
  eligible: number;
  posted: number;
  failed: string[];
  skipped: number;
}

/**
 * What the post says.
 *
 * The templated sentence, not the generated one. Templates are assembled from
 * the record and are certainly true; a fluent sentence that might not be is
 * exactly the wrong thing to put somewhere it cannot be edited. No hashtags, no
 * exclamation, no adjectives — the numbers are the point.
 */
export function composePost(event: EventRecord): string | null {
  const sentence = templatedSentence(event);
  if (sentence === null) return null;

  const text = `${sentence}\n\n${SITE_ORIGIN}${eventPath(event)}`;
  return postLength(text) > MAX_POST_LENGTH ? null : text;
}

export async function runAnnounce(options: AnnounceOptions = {}): Promise<AnnounceResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = options.limit ?? DEFAULT_POSTS_PER_RUN;

  const client =
    options.client ??
    createXClient({
      credentials: {
        apiKey: process.env['X_API_KEY'] ?? '',
        apiSecret: process.env['X_API_SECRET'] ?? '',
        accessToken: process.env['X_ACCESS_TOKEN'] ?? '',
        accessSecret: process.env['X_ACCESS_SECRET'] ?? '',
      },
    });

  const announced = new Map(readAnnouncements().map((row) => [row.eventId, row]));
  const all = readAllEvents();

  const superseded = new Set(
    all.map((event) => event.supersedes).filter((id): id is string => id !== null),
  );

  const eligible = all.filter(
    (event) =>
      event.confidence === 'confirmed' &&
      event.kind !== 'correction' &&
      // A finding that has since been retracted must never be announced, even
      // if it was confirmed when it was recorded.
      !superseded.has(event.id) &&
      !announced.has(event.id),
  );

  const failed: string[] = [];
  let posted = 0;
  let skipped = 0;

  for (const event of eligible.slice(0, limit)) {
    const text = composePost(event);

    if (text === null) {
      // No sentence can be built from this record that is both true and short
      // enough. Recording the skip stops it being reconsidered every run.
      skipped += 1;
      announced.set(event.id, {
        eventId: event.id,
        state: 'failed',
        postId: null,
        text: null,
        error: 'no sentence could be assembled within the length limit',
        announcedAt: nowIso,
      });
      continue;
    }

    try {
      const result = await client.post(text);
      posted += 1;
      announced.set(event.id, {
        eventId: event.id,
        state: 'posted',
        postId: result.id,
        text,
        error: null,
        announcedAt: nowIso,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(`${event.id}: ${message}`);
      // Not recorded, so the next run retries. A transport failure is not an
      // answer, and an unposted finding should not be silently dropped.
    }
  }

  writeAnnouncements([...announced.values()]);

  return { eligible: eligible.length, posted, failed, skipped };
}
