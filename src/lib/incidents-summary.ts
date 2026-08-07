import { PROVIDERS } from '../collectors/incidents.ts';
import type { IncidentRow } from '../types/incidents.ts';

/**
 * Providers side by side, over one window.
 *
 * The comparison is the whole point and it is also the dangerous part. A count
 * measures how often a provider *announced* something, not how often it broke,
 * and the two diverge in a direction that punishes honesty: a company that
 * posts every degradation will out-count one that posts nothing. Anything
 * rendered from this has to say that where the number is, not in a footnote.
 */

export interface ProviderIncidents {
  slug: string;
  name: string;
  /** Incidents inside the window. */
  count: number;
  /** Of those, how many the provider marked resolved. */
  resolved: number;
  /** ISO 8601 of the most recent, or null when the window is empty. */
  latestAt: string | null;
  latestTitle: string | null;
}

export interface IncidentSummary {
  /** Days the counts cover. */
  windowDays: number;
  /** Providers with a feed on record, whatever it said. */
  providers: number;
  /** Incidents across every provider inside the window. */
  total: number;
  /** Days of history the oldest row here goes back to. */
  observedDays: number;
  /** Busiest first. Every tracked provider appears, including the quiet ones. */
  byProvider: ProviderIncidents[];
  /** Newest first, across all providers. Bounded — see `RECENT_LIMIT`. */
  recent: { provider: string; name: string; title: string; at: string; url: string }[];
}

export const WINDOW_DAYS = 90;
export const RECENT_LIMIT = 12;

export function summariseIncidents(
  rows: readonly IncidentRow[],
  today: string,
  windowDays = WINDOW_DAYS,
): IncidentSummary {
  const now = Date.parse(`${today}T00:00:00Z`);
  const cutoff = now - windowDays * 86_400_000;
  const named = new Map(PROVIDERS.map((provider) => [provider.slug, provider.name]));

  const inWindow = rows.filter((row) => Date.parse(row.startedAt) >= cutoff);

  const byProvider: ProviderIncidents[] = PROVIDERS.map((provider) => {
    const mine = inWindow
      .filter((row) => row.provider === provider.slug)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

    return {
      slug: provider.slug,
      name: provider.name,
      count: mine.length,
      resolved: mine.filter((row) => row.resolved).length,
      latestAt: mine[0]?.startedAt ?? null,
      latestTitle: mine[0]?.title ?? null,
    };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const oldest = rows.reduce(
    (earliest, row) => Math.min(earliest, Date.parse(row.startedAt)),
    Number.POSITIVE_INFINITY,
  );

  const recent = [...inWindow]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, RECENT_LIMIT)
    .map((row) => ({
      provider: row.provider,
      name: named.get(row.provider) ?? row.provider,
      title: row.title,
      at: row.startedAt,
      url: row.url,
    }));

  return {
    windowDays,
    providers: PROVIDERS.length,
    total: inWindow.length,
    observedDays: Number.isFinite(oldest) ? Math.max(0, Math.round((now - oldest) / 86_400_000)) : 0,
    byProvider,
    recent,
  };
}
