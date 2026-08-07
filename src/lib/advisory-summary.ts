import type { AdoptionRow } from '../types/adoption.ts';
import type { HealthRow } from '../types/health.ts';

/**
 * Advisory load, split by ecosystem.
 *
 * Costs nothing to collect: the advisory counts are already read from OSV for
 * every watched repository, and the registry each one publishes to is already
 * mapped for download counts. Joining the two is the only thing missing, and
 * the result — "how does the npm side of this watchlist compare with the crates
 * side" — is a comparison nobody publishes.
 *
 * Three things it is not, all of which have to reach the page.
 *
 * It is not a survey of any ecosystem. It is a hand-picked list of a few dozen
 * projects per registry, chosen for being prominent, which is exactly the
 * population most likely to have advisories filed against it.
 *
 * A count is all-time. A mature well-patched project carries more than a young
 * one, so a high number is as easily a sign of age and scrutiny as of danger.
 *
 * And the ecosystems are not the same size or the same age. npm packages are
 * smaller and more numerous; a crate is more likely to be one library. Per
 * package is the only comparison worth making, and even that one is soft.
 */

export interface EcosystemAdvisories {
  registry: string;
  /** Watched packages published to this registry with a repository reading. */
  packages: number;
  /** Of those, how many have at least one advisory on record. */
  affected: number;
  /** Advisories across them, all time. */
  advisories: number;
  /** Advisories per affected package, to one decimal. Null with none affected. */
  perAffected: number | null;
  /** Worst first. Bounded — see `WORST_LIMIT`. */
  worst: { repo: string; name: string; advisories: number }[];
}

export interface AdvisorySummary {
  /** Registries with at least one measured package. */
  registries: number;
  /** Advisories across every registry below. */
  total: number;
  byRegistry: EcosystemAdvisories[];
}

export const WORST_LIMIT = 5;

export function summariseAdvisories(
  packages: readonly AdoptionRow[],
  health: readonly HealthRow[],
): AdvisorySummary {
  const advisoriesByRepo = new Map(
    health
      .filter((row) => row.advisories !== null)
      .map((row) => [row.id, row.advisories as number]),
  );

  // One entry per registry and package name. A package mapped from two watched
  // repositories would otherwise count its advisories twice.
  const seen = new Set<string>();
  const grouped = new Map<string, { repo: string; name: string; advisories: number }[]>();

  for (const entry of packages) {
    const key = `${entry.registry} ${entry.name}`;
    if (seen.has(key)) continue;

    const advisories = advisoriesByRepo.get(entry.id);
    // A repository OSV was never asked about is absent, not zero. Counting it
    // as clean would flatter whichever ecosystem happened to be unread.
    if (advisories === undefined) continue;
    seen.add(key);

    const list = grouped.get(entry.registry);
    const row = { repo: entry.id, name: entry.name, advisories };
    if (list) list.push(row);
    else grouped.set(entry.registry, [row]);
  }

  const byRegistry: EcosystemAdvisories[] = [...grouped.entries()]
    .map(([registry, rows]) => {
      const affected = rows.filter((row) => row.advisories > 0);
      const advisories = rows.reduce((sum, row) => sum + row.advisories, 0);

      return {
        registry,
        packages: rows.length,
        affected: affected.length,
        advisories,
        perAffected:
          affected.length === 0 ? null : Math.round((advisories / affected.length) * 10) / 10,
        worst: [...affected]
          .sort((a, b) => b.advisories - a.advisories || a.name.localeCompare(b.name))
          .slice(0, WORST_LIMIT),
      };
    })
    .sort((a, b) => b.advisories - a.advisories || a.registry.localeCompare(b.registry));

  return {
    registries: byRegistry.length,
    total: byRegistry.reduce((sum, row) => sum + row.advisories, 0),
    byRegistry,
  };
}
