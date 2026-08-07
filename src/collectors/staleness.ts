/**
 * When a package was last shipped, as opposed to last committed to.
 *
 * Every "is this maintained?" answer in circulation reads a repository's last
 * push. That is the wrong field. A push is what a maintainer does for
 * themselves; a publish is what reaches the two hundred projects depending on
 * them, and the two come apart all the time — an active repository whose
 * package has not moved in two years is the common shape of an abandoned
 * dependency, and it looks healthy on every badge there is.
 *
 * Read from the registries themselves, so nothing here depends on GitHub. The
 * package list is the one already mapped for download counts.
 */

import type { AdoptionRow } from '../types/adoption.ts';
import type { StalenessRow } from '../types/staleness.ts';
import { sleep, ThrottledError } from '../lib/registries.ts';

const USER_AGENT = 'readout-agent (+https://github.com/kaitzyy-dev/readout)';

/**
 * Homebrew is absent. A formula has a version but no publish date of its own —
 * it records when somebody packaged software, not when the software shipped —
 * and reporting that as a release date would be a different fact wearing this
 * one's label.
 */
export const REGISTRIES = ['npm', 'pypi', 'crates'] as const;

/** The same politeness the download collector uses, for the same registries. */
export const DELAY_MS = 1200;

export interface StalenessClient {
  /** Newest published version and its date, or null when the read failed. */
  lastPublish(registry: string, name: string): Promise<{ at: string; version: string } | null>;
  requests(): number;
}

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
  // 429 is a rate limit, not an answer. Told apart from a genuine 404 so a
  // throttled read never gets recorded as a package that stopped existing.
  if (response.status === 429) throw new ThrottledError(url, 429);
  if (!response.ok) return null;
  return response.json();
}

export function createStalenessClient(): StalenessClient {
  let spent = 0;

  return {
    requests: () => spent,

    async lastPublish(registry, name) {
      spent += 1;

      if (registry === 'npm') {
        const body = (await json(`https://registry.npmjs.org/${encodeURIComponent(name)}`)) as {
          time?: Record<string, string>;
          'dist-tags'?: { latest?: string };
        } | null;
        const version = body?.['dist-tags']?.latest;
        const at = version === undefined ? undefined : body?.time?.[version];
        return at === undefined || version === undefined ? null : { at, version };
      }

      if (registry === 'pypi') {
        const body = (await json(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)) as {
          info?: { version?: string };
          releases?: Record<string, { upload_time_iso_8601?: string }[]>;
        } | null;
        const version = body?.info?.version;
        const at = version === undefined ? undefined : body?.releases?.[version]?.[0]?.upload_time_iso_8601;
        return at === undefined || version === undefined ? null : { at, version };
      }

      if (registry === 'crates') {
        const body = (await json(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)) as {
          crate?: { updated_at?: string; max_version?: string };
        } | null;
        const at = body?.crate?.updated_at;
        const version = body?.crate?.max_version;
        return at === undefined || version === undefined ? null : { at, version };
      }

      return null;
    },
  };
}

export function daysSince(iso: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(iso)) / 86_400_000);
}

export interface StalenessCollectionResult {
  rows: StalenessRow[];
  errors: string[];
  requests: number;
}

export interface StalenessCollectionOptions {
  now: string;
  client?: StalenessClient;
  delayMs?: number;
  /** Registries to read. Defaults to `REGISTRIES`. */
  registries?: readonly string[];
}

export async function collectStaleness(
  packages: readonly AdoptionRow[],
  previous: readonly StalenessRow[],
  options: StalenessCollectionOptions,
): Promise<StalenessCollectionResult> {
  const client = options.client ?? createStalenessClient();
  const registries = new Set(options.registries ?? REGISTRIES);
  const errors: string[] = [];
  const rows: StalenessRow[] = [];

  const before = new Map(previous.map((row) => [`${row.registry} ${row.name}`, row]));
  const wanted = packages.filter((row) => registries.has(row.registry));

  // One row per registry and name. A package published from two watched
  // repositories is one package, and reading it twice would spend a request to
  // learn the same date.
  const seen = new Set<string>();

  for (const [index, entry] of wanted.entries()) {
    const key = `${entry.registry} ${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (index > 0) await sleep(options.delayMs ?? DELAY_MS);

    const held = before.get(key);

    let reading: { at: string; version: string } | null;
    try {
      reading = await client.lastPublish(entry.registry, entry.name);
    } catch (error) {
      // Throttling and outages both land here, and neither is news about a
      // package. The last known date is carried forward untouched.
      errors.push(
        `staleness ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (held !== undefined) rows.push(held);
      continue;
    }

    if (reading === null) {
      // A registry that answers but has nothing for this name. Kept at its last
      // known date rather than recorded as never published — an unreadable read
      // and a package with no releases are different facts.
      if (held !== undefined) rows.push(held);
      else errors.push(`staleness ${key}: no published version found`);
      continue;
    }

    rows.push({
      registry: entry.registry,
      name: entry.name,
      repo: entry.id,
      lastPublish: reading.at.slice(0, 10),
      version: reading.version,
      observedAt: options.now,
    });
  }

  return { rows, errors, requests: client.requests() };
}
