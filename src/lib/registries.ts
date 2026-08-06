/**
 * Download and install counts from the package registries.
 *
 * Every endpoint here is free, unauthenticated, and run by somebody else. That
 * shapes the design more than anything: batch where a batch endpoint exists,
 * never retry in a tight loop, and treat a failure as a missing reading rather
 * than as an error worth stopping for. Nothing on this path is urgent.
 *
 * Verified against the live services before it was written, because
 * `free-tier-guard` treats limits as facts to check rather than estimates to
 * assume:
 *
 *   - npm answers up to 128 packages in one request and 400s at 129.
 *   - npm rejects scoped names in a batch; they must be fetched alone.
 *   - An unknown npm package comes back as null inside the batch rather than
 *     failing the whole request.
 *   - Homebrew publishes install counts for every formula as a single file.
 *   - crates.io refuses requests without a User-Agent.
 *
 * The whole watchlist costs roughly a hundred requests a day, against GitHub's
 * five thousand an hour. It is not close to anything.
 */

import type { AdoptionRegistry, AdoptionWindow } from '../types/adoption.ts';

/** Identifies the agent, and crates.io requires one. */
const USER_AGENT = 'readout-agent (+https://github.com/kaitzyy-dev/readout)';

/** Verified: 128 succeeds, 129 does not. */
export const NPM_BATCH = 128;

export const WINDOW_OF: Record<AdoptionRegistry, AdoptionWindow> = {
  npm: 'week',
  pypi: 'week',
  crates: '90d',
  brew: '30d',
};

export interface RegistryClient {
  /** Weekly downloads by package name. Absent key means no reading. */
  npmDownloads(names: readonly string[]): Promise<Map<string, number>>;
  /** Thirty-day installs for every formula, in one request. */
  brewInstalls(): Promise<Map<string, number>>;
  pypiDownloads(name: string): Promise<number | null>;
  cratesDownloads(name: string): Promise<number | null>;
  /** Requests spent, for the run record. */
  requests(): number;
}

/**
 * Raised when a registry refuses because it is being asked too fast.
 *
 * Separated from "no such package" on purpose. The first version returned null
 * for both, and a run that tripped pypistats' rate limit was indistinguishable
 * from a run where half the packages had been delisted — 31 of 63 PyPI reads
 * came back empty with nothing recorded anywhere to say why. A missing reading
 * has to be able to explain itself.
 */
export class ThrottledError extends Error {
  constructor(url: string, status: number, options?: ErrorOptions) {
    super(status === 0 ? `registry unreachable: ${url}` : `registry refused with ${status}: ${url}`, options);
    this.name = 'ThrottledError';
  }
}

async function getJson(url: string): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  } catch (error) {
    // Unreachable is a missing reading, not a failed run. The site already
    // knows how to render "not measured" and must never render it as a zero.
    throw new ThrottledError(url, 0, { cause: error });
  }

  // 404 is an answer: no such package. Anything else in this range is our
  // problem — a bad name we generated — and is still not a reading.
  if (response.status === 404) return null;
  if (response.status === 429 || response.status >= 500) {
    throw new ThrottledError(url, response.status);
  }
  if (!response.ok) return null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Pacing for the endpoints with no batch form. Verified the hard way. */
export const PER_PACKAGE_DELAY_MS = 400;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split into batches, with scoped names separated out — npm 400s on those. */
export function npmBatches(names: readonly string[]): { batched: string[][]; single: string[] } {
  const single = names.filter((name) => name.startsWith('@'));
  const plain = names.filter((name) => !name.startsWith('@'));

  const batched: string[][] = [];
  for (let i = 0; i < plain.length; i += NPM_BATCH) {
    batched.push(plain.slice(i, i + NPM_BATCH));
  }

  return { batched, single };
}

export function createRegistryClient(
  fetchImpl: typeof fetch = fetch,
): RegistryClient {
  let spent = 0;

  const json = async (url: string): Promise<unknown | null> => {
    spent += 1;
    const previous = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      return await getJson(url);
    } finally {
      globalThis.fetch = previous;
    }
  };

  return {
    requests: () => spent,

    async npmDownloads(names) {
      const out = new Map<string, number>();
      const { batched, single } = npmBatches(names);

      for (const batch of batched) {
        const body = (await json(
          `https://api.npmjs.org/downloads/point/last-week/${batch.join(',')}`,
        )) as Record<string, { downloads?: number } | null> | null;
        if (body === null) continue;

        for (const [name, entry] of Object.entries(body)) {
          // Unknown packages come back as an explicit null. That is "no such
          // package", which is not the same as zero downloads.
          if (entry !== null && typeof entry.downloads === 'number') {
            out.set(name, entry.downloads);
          }
        }
      }

      for (const name of single) {
        const body = (await json(
          `https://api.npmjs.org/downloads/point/last-week/${name}`,
        )) as { downloads?: number } | null;
        if (body !== null && typeof body.downloads === 'number') out.set(name, body.downloads);
      }

      return out;
    },

    async brewInstalls() {
      const out = new Map<string, number>();
      const body = (await json('https://formulae.brew.sh/api/analytics/install/30d.json')) as {
        items?: { formula?: string; count?: number | string }[];
      } | null;
      if (body === null) return out;

      for (const item of body.items ?? []) {
        if (typeof item.formula !== 'string') continue;
        // Counts arrive comma-grouped as strings in this feed.
        const count = Number(String(item.count ?? '').replace(/,/g, ''));
        if (Number.isFinite(count)) {
          // Formulae are listed per invocation path; the same formula appears
          // more than once and the totals belong together.
          out.set(item.formula, (out.get(item.formula) ?? 0) + count);
        }
      }

      return out;
    },

    async pypiDownloads(name) {
      const body = (await json(
        `https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`,
      )) as { data?: { last_week?: number } } | null;
      const count = body?.data?.last_week;
      return typeof count === 'number' ? count : null;
    },

    async cratesDownloads(name) {
      const body = (await json(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)) as {
        crate?: { recent_downloads?: number | null };
      } | null;
      const count = body?.crate?.recent_downloads;
      return typeof count === 'number' ? count : null;
    },
  };
}
