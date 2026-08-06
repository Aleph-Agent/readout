/**
 * The adoption collector: what is actually being installed.
 *
 * This is the second axis. Everything else in the project reads GitHub, which
 * measures what people build and says nothing about whether anyone runs it.
 * Stars and forks are both cheap to manufacture; twenty million installs a week
 * are not. That makes this the hardest signal here to fake and the only one
 * that always has a value — which is also why it is the one that stops the site
 * being an empty page on a quiet day.
 *
 * Pure except for the client, so every edge is testable offline: a registry
 * down, a package delisted, a repository publishing to three registries at
 * once, a count that goes backwards.
 */

import {
  createRegistryClient,
  PER_PACKAGE_DELAY_MS,
  sleep,
  ThrottledError,
  WINDOW_OF,
  type RegistryClient,
} from '../lib/registries.ts';
import type {
  AdoptionRegistry,
  AdoptionRow,
  AdoptionSample,
} from '../types/adoption.ts';
import type { WatchlistEntry } from '../types/watchlist.ts';

/**
 * How much trend to keep per package.
 *
 * Long enough to see a relicensing play out — the interesting question is what
 * happens over the weeks after, not the day of — and short enough that the file
 * stays a few hundred kilobytes for ever.
 */
export const TREND_DAYS = 35;

export interface AdoptionCollectionResult {
  rows: AdoptionRow[];
  errors: string[];
  /** Registries that answered nothing this run. Reported, never inferred as 0. */
  missed: AdoptionRegistry[];
  requests: number;
}

export interface AdoptionCollectionOptions {
  /** ISO 8601 UTC of this run. */
  now: string;
  client?: RegistryClient;
  trendDays?: number;
  /** Pacing between per-package reads. Zero in tests, which make no requests. */
  delayMs?: number;
}

/**
 * Identity of one row: a package, in a registry, attributed to a repository.
 *
 * Built with a join rather than an interpolated template. Twice now a literal
 * space written between `}` and `${` has reached disk as a NUL byte, which
 * makes the whole file read as binary to grep and to the editor. Not worth
 * risking a third time for a construct with an exact equivalent.
 */
export function rowKey(id: string, registry: string, name: string): string {
  return [id, registry, name].join(' ');
}

/** `npm:react` → `{ registry: 'npm', name: 'react' }`. Unknown prefixes drop. */
export function parsePackageId(
  packageId: string,
): { registry: AdoptionRegistry; name: string } | null {
  const separator = packageId.indexOf(':');
  if (separator < 1) return null;

  const registry = packageId.slice(0, separator);
  const name = packageId.slice(separator + 1);
  if (name === '') return null;

  return registry === 'npm' || registry === 'pypi' || registry === 'crates' || registry === 'brew'
    ? { registry, name }
    : null;
}

/**
 * Fold a reading into a package's trend.
 *
 * A count that did not move still appends: unlike a fork count, a flat download
 * week is itself the measurement, and dropping it would make a dead package
 * indistinguishable from one nobody read this week.
 */
export function recordAdoption(
  samples: readonly AdoptionSample[],
  at: string,
  count: number,
  trendDays: number = TREND_DAYS,
): AdoptionSample[] {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error(`recordAdoption: "${at}" is not an ISO timestamp`);

  // One reading per day. A re-run on the same day replaces rather than doubling
  // the series, so the trend cannot be inflated by operational retries.
  const day = at.slice(0, 10);
  const kept = samples.filter((sample) => sample.at.slice(0, 10) !== day);
  const floor = atMs - trendDays * 86_400_000;

  return [...kept.filter((sample) => Date.parse(sample.at) >= floor), { at, count }].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );
}

export async function collectAdoption(
  watchlist: readonly WatchlistEntry[],
  previous: readonly AdoptionRow[],
  options: AdoptionCollectionOptions,
): Promise<AdoptionCollectionResult> {
  const client = options.client ?? createRegistryClient();
  const trendDays = options.trendDays ?? TREND_DAYS;
  const errors: string[] = [];
  const missed: AdoptionRegistry[] = [];

  // Every package the watchlist declares, grouped by registry so the batch
  // endpoints can be used where they exist.
  const wanted = new Map<AdoptionRegistry, Map<string, string[]>>();
  for (const entry of watchlist) {
    if (!entry.active) continue;
    // The ledger can lag the schema: `packages` was added after 400 entries
    // already existed, and a watchlist written before that has no such key. A
    // missing field is an empty list, not a crash.
    for (const packageId of entry.packages ?? []) {
      const parsed = parsePackageId(packageId);
      if (parsed === null) {
        errors.push(`adoption ${entry.id}: "${packageId}" is not a known registry:name pair`);
        continue;
      }

      const byName = wanted.get(parsed.registry) ?? new Map<string, string[]>();
      // Two repositories can legitimately claim one package — a monorepo split
      // across watchlist entries — so the reading is fetched once and attributed
      // to each.
      byName.set(parsed.name, [...(byName.get(parsed.name) ?? []), entry.id]);
      wanted.set(parsed.registry, byName);
    }
  }

  const counts = new Map<AdoptionRegistry, Map<string, number>>();

  const npmNames = [...(wanted.get('npm')?.keys() ?? [])];
  if (npmNames.length > 0) {
    try {
      const found = await client.npmDownloads(npmNames);
      counts.set('npm', found);
      if (found.size === 0) missed.push('npm');
    } catch (error) {
      errors.push(`adoption npm: ${error instanceof Error ? error.message : String(error)}`);
      missed.push('npm');
    }
  }

  const brewNames = new Set(wanted.get('brew')?.keys() ?? []);
  if (brewNames.size > 0) {
    try {
      const all = await client.brewInstalls();
      const found = new Map<string, number>();
      for (const name of brewNames) {
        const count = all.get(name);
        if (count !== undefined) found.set(name, count);
      }
      counts.set('brew', found);
      if (all.size === 0) missed.push('brew');
    } catch (error) {
      errors.push(`adoption brew: ${error instanceof Error ? error.message : String(error)}`);
      missed.push('brew');
    }
  }

  // No batch endpoint for these two, so one request each — paced, because the
  // first unpaced run tripped pypistats' rate limit and lost 31 of 63 readings
  // without recording that anything had gone wrong.
  for (const registry of ['pypi', 'crates'] as const) {
    const names = [...(wanted.get(registry)?.keys() ?? [])];
    if (names.length === 0) continue;

    const found = new Map<string, number>();
    let refused = 0;

    for (const [index, name] of names.entries()) {
      if (index > 0) await sleep(options.delayMs ?? PER_PACKAGE_DELAY_MS);

      try {
        const count =
          registry === 'pypi'
            ? await client.pypiDownloads(name)
            : await client.cratesDownloads(name);
        if (count !== null) found.set(name, count);
      } catch (error) {
        // Being refused is a different fact from a package not existing, and
        // the run record has to be able to tell them apart afterwards.
        refused += 1;
        if (error instanceof ThrottledError) continue;
        errors.push(
          `adoption ${registry} ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (refused > 0) {
      errors.push(
        `adoption ${registry}: refused ${refused} of ${names.length} reads, last known counts carried forward`,
      );
    }

    counts.set(registry, found);
    if (found.size === 0) missed.push(registry);
  }

  // Previous readings, so a registry that failed carries its trend forward
  // rather than losing it.
  const before = new Map(previous.map((row) => [rowKey(row.id, row.registry, row.name), row]));

  const rows: AdoptionRow[] = [];
  for (const [registry, byName] of wanted) {
    for (const [name, repos] of byName) {
      const count = counts.get(registry)?.get(name);

      for (const id of repos) {
        const existing = before.get(rowKey(id, registry, name));

        rows.push({
          id,
          registry,
          name,
          // A registry that could not be read leaves the last known count in
          // place and appends no sample. Writing null here would make the site
          // say the package vanished; writing zero would be worse.
          count: count ?? existing?.count ?? null,
          window: WINDOW_OF[registry],
          samples:
            count === undefined
              ? (existing?.samples ?? [])
              : recordAdoption(existing?.samples ?? [], options.now, count, trendDays),
        });
      }
    }
  }

  return { rows, errors, missed, requests: client.requests() };
}
