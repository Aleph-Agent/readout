/**
 * Names one keystroke away from something people install every day.
 *
 * A typosquat is not a vulnerability in anything — it is a package that exists
 * and waits. `lodahs`, `expresss`, `python-dateutil` spelled with an underscore.
 * The registries do remove them, eventually, and in between the only thing
 * standing between a developer and one is that they typed carefully.
 *
 * Nobody publishes a live list. Security vendors sell one.
 *
 * What this does and does not claim matters more here than anywhere else in the
 * product, because the output is a list of named packages sitting next to the
 * word "typosquat". It claims exactly one thing: this name exists on npm and is
 * one edit away from that name. It does not claim the package is malicious, and
 * the page must not either — plenty of near-miss names are forks, ports,
 * translations, or someone's abandoned first attempt. Calling one of those
 * malicious in public would be defamation with a build step.
 */

import type { AdoptionRow } from '../types/adoption.ts';
import type { TyposquatRow } from '../types/typosquat.ts';
import { sleep } from '../lib/registries.ts';

const USER_AGENT = 'readout-agent (+https://github.com/kaitzyy-dev/readout)';

export const DELAY_MS = 250;

/** A name shorter than this has too many neighbours for any of them to mean much. */
export const MIN_LENGTH = 4;

/** Packages checked per run, most installed first. Keeps the request count sane. */
export const DEFAULT_LIMIT = 12;

/**
 * Candidate names, generated rather than searched for.
 *
 * npm's search was the obvious route and it is the wrong instrument: it ranks
 * by relevance and popularity, so a query for `express` returns `express-session`
 * and `swagger-ui-express` and nothing at edit distance 1. A typosquat is
 * unpopular by construction — that is what makes it a typosquat — so the one
 * ranking the API offers is precisely the one that hides them.
 *
 * Generating the candidates and asking the registry whether each exists is the
 * only route left. The full edit-distance-1 space is around four hundred names
 * per package, which is both too many requests and rude, so this generates the
 * two classes that account for most real typosquats and stops.
 *
 * Deletions: a key that did not register. `expres`, `lodsh`.
 * Transpositions: two keys in the wrong order. `exrpess`, `lodahs`.
 *
 * Both are bounded by name length, so a seven-character package costs thirteen
 * requests rather than four hundred. Substitutions and insertions are not
 * covered, so this finds fewer than exist and never claims otherwise.
 */
export function candidates(name: string): string[] {
  const found = new Set<string>();

  for (let i = 0; i < name.length; i += 1) {
    found.add(name.slice(0, i) + name.slice(i + 1));
  }

  for (let i = 0; i < name.length - 1; i += 1) {
    found.add(name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2));
  }

  found.delete(name);
  // npm rejects anything under one character, and a two-character name has
  // nothing to say about a typo.
  return [...found].filter((candidate) => candidate.length >= 2).sort();
}

export interface TyposquatClient {
  /** When this name last published, or null when it does not exist. */
  published(name: string): Promise<string | null>;
  requests(): number;
}

export function createTyposquatClient(): TyposquatClient {
  let spent = 0;
  return {
    requests: () => spent,
    async published(name) {
      spent += 1;
      // The abbreviated document. The full one for a popular package is
      // megabytes of version history, and the only field wanted is a date.
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/vnd.npm.install-v1+json',
        },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`${response.status} reading ${name}`);

      const body = (await response.json()) as { modified?: string };
      return typeof body.modified === 'string' ? body.modified : '';
    },
  };
}

export interface TyposquatCollectionResult {
  rows: TyposquatRow[];
  errors: string[];
  requests: number;
}

export interface TyposquatCollectionOptions {
  now: string;
  client?: TyposquatClient;
  delayMs?: number;
  /** Packages checked per run. Keeps the daily job bounded. */
  limit?: number;
}

export async function collectTyposquats(
  packages: readonly AdoptionRow[],
  previous: readonly TyposquatRow[],
  options: TyposquatCollectionOptions,
): Promise<TyposquatCollectionResult> {
  const client = options.client ?? createTyposquatClient();
  const errors: string[] = [];

  // Most installed first. A near-miss on a package nobody types reaches nobody,
  // and the whole risk here scales with how often the real name is typed.
  const wanted = [...packages]
    .filter((row) => row.registry === 'npm' && row.name.length >= MIN_LENGTH)
    // Unread is not zero, but for ordering it is the same answer, and `null`
    // would otherwise poison the comparison.
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, options.limit ?? DEFAULT_LIMIT);

  const found = new Map(previous.map((row) => [`${row.canonical} ${row.name}`, row]));
  const checked = new Set<string>();
  let first = true;

  for (const entry of wanted) {
    if (checked.has(entry.name)) continue;
    checked.add(entry.name);

    // Cleared before the sweep, so a name that has since been taken down stops
    // being listed. Naming a package that no longer exists beside the word
    // typosquat is the one outcome here with no upside whatsoever.
    const carried: TyposquatRow[] = [];
    for (const [key, row] of found) {
      if (key.startsWith(`${entry.name} `)) {
        carried.push(row);
        found.delete(key);
      }
    }

    let failed = false;

    for (const candidate of candidates(entry.name)) {
      if (!first) await sleep(options.delayMs ?? DELAY_MS);
      first = false;

      let published: string | null;
      try {
        published = await client.published(candidate);
      } catch (error) {
        // One unreadable probe is not evidence of absence.
        failed = true;
        errors.push(
          `typosquat ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      if (published === null) continue;

      found.set(`${entry.name} ${candidate}`, {
        canonical: entry.name,
        name: candidate,
        distance: 1,
        lastPublish: published.slice(0, 10),
        observedAt: options.now,
      });
    }

    // A sweep that hit errors cannot distinguish "gone" from "unread", so the
    // previous findings for this name go back rather than being dropped.
    if (failed) {
      for (const row of carried) {
        if (!found.has(`${row.canonical} ${row.name}`)) found.set(`${row.canonical} ${row.name}`, row);
      }
    }
  }

  return { rows: [...found.values()], errors, requests: client.requests() };
}
