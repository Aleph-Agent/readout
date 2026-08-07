/**
 * What a base image weighs, and when it was last rebuilt.
 *
 * Every Dockerfile in the world starts with one of about twenty lines, and the
 * two facts that matter about that line are invisible from inside it: how many
 * megabytes it costs on every pull, and whether the image behind the tag has
 * been rebuilt since the last round of distribution security patches.
 *
 * Docker Hub publishes both, free and unauthenticated, and nobody puts them
 * side by side. `node:24` against `node:24-alpine` is a factor of five, and the
 * factor changes quietly as base distributions move.
 *
 * A tag is a moving target: `node:24` today is not `node:24` last month. That
 * is the whole reason the date is worth recording — a tag nobody has rebuilt in
 * six months is shipping six months of unpatched distribution packages, and it
 * looks identical to one rebuilt this morning.
 */

import type { ImageRow } from '../types/images.ts';
import { sleep } from '../lib/registries.ts';

const USER_AGENT = 'readout-agent (+https://github.com/kaitzyy-dev/readout)';

export const DELAY_MS = 200;

/**
 * Curated. The tags people actually write, not every tag that exists — `node`
 * alone publishes nine thousand.
 */
export const TRACKED: readonly { image: string; tags: readonly string[] }[] = [
  { image: 'node', tags: ['24', '24-alpine', '24-slim', '22', '22-alpine'] },
  { image: 'python', tags: ['3.13', '3.13-alpine', '3.13-slim', '3.12', '3.12-slim'] },
  { image: 'golang', tags: ['1.24', '1.24-alpine'] },
  { image: 'rust', tags: ['1', '1-alpine', '1-slim'] },
  { image: 'ruby', tags: ['3.4', '3.4-alpine', '3.4-slim'] },
  { image: 'openjdk', tags: ['25', '25-slim'] },
  { image: 'alpine', tags: ['3.22', 'latest'] },
  { image: 'debian', tags: ['trixie', 'trixie-slim', 'bookworm-slim'] },
  { image: 'ubuntu', tags: ['24.04', 'latest'] },
  { image: 'postgres', tags: ['18', '18-alpine', '17-alpine'] },
  { image: 'mysql', tags: ['9', '8'] },
  { image: 'redis', tags: ['8', '8-alpine'] },
  { image: 'mongo', tags: ['8'] },
  { image: 'nginx', tags: ['stable', 'stable-alpine', 'alpine'] },
  { image: 'caddy', tags: ['2', '2-alpine'] },
  { image: 'busybox', tags: ['latest'] },
];

export interface ImageClient {
  /** One tag on one official image, or null when the registry has no such tag. */
  tag(image: string, tag: string): Promise<{ bytes: number; updatedAt: string } | null>;
  requests(): number;
}

export function createImageClient(): ImageClient {
  let spent = 0;
  return {
    requests: () => spent,
    // Asked for by name rather than paged through. The tag list is ordered by
    // last-rebuilt and `node` alone publishes nine thousand of them, so a page
    // of a hundred silently omitted `24-alpine` — reported as a tag that had
    // stopped existing when it had simply not been rebuilt as recently as a
    // hundred others.
    async tag(image, wanted) {
      spent += 1;
      const response = await fetch(
        `https://hub.docker.com/v2/repositories/library/${encodeURIComponent(image)}/tags/${encodeURIComponent(wanted)}`,
        { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } },
      );
      if (!response.ok) return null;

      const body = (await response.json()) as { full_size?: number; last_updated?: string };
      if (typeof body.full_size !== 'number' || typeof body.last_updated !== 'string') return null;

      return { bytes: body.full_size, updatedAt: body.last_updated };
    },
  };
}

export interface ImageCollectionResult {
  rows: ImageRow[];
  errors: string[];
  requests: number;
}

export interface ImageCollectionOptions {
  now: string;
  client?: ImageClient;
  delayMs?: number;
  tracked?: readonly { image: string; tags: readonly string[] }[];
}

export async function collectImages(
  previous: readonly ImageRow[],
  options: ImageCollectionOptions,
): Promise<ImageCollectionResult> {
  const client = options.client ?? createImageClient();
  const tracked = options.tracked ?? TRACKED;
  const errors: string[] = [];
  const rows: ImageRow[] = [];

  const before = new Map(previous.map((row) => [`${row.image} ${row.tag}`, row]));

  let first = true;

  for (const entry of tracked) {
    for (const wanted of entry.tags) {
      if (!first) await sleep(options.delayMs ?? DELAY_MS);
      first = false;

      const key = `${entry.image} ${wanted}`;
      const held = before.get(key);

      let tag: { bytes: number; updatedAt: string } | null;
      try {
        tag = await client.tag(entry.image, wanted);
      } catch (error) {
        errors.push(`images ${key}: ${error instanceof Error ? error.message : String(error)}`);
        if (held !== undefined) rows.push(held);
        continue;
      }

      if (tag === null) {
        // A tag that has gone is worth saying out loud, not dropping quietly:
        // the point of tracking `node:22` is noticing the day it stops being
        // published. The last reading stays until something replaces it.
        if (held !== undefined) rows.push(held);
        errors.push(`images ${entry.image}:${wanted}: no longer published`);
        continue;
      }

      rows.push({
        image: entry.image,
        tag: wanted,
        bytes: tag.bytes,
        updatedAt: tag.updatedAt,
        observedAt: options.now,
      });
    }
  }

  return { rows, errors, requests: client.requests() };
}
