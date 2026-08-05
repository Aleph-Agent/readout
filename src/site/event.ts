import { esc, eventSlug, layout, SITE_ORIGIN, stateBadge } from './render.ts';
import { templatedSentence } from '../lib/validate.ts';
import type { IndexBundle } from '../types/bundles.ts';
import type { EventRecord } from '../types/events.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * One finding, one address.
 *
 * What anybody shares is a single reading, not a homepage. Until now findings
 * lived inside a lens page with nothing to link to, so there was no way to send
 * one to somebody. This gives each its own URL, its own title, and its own link
 * preview.
 *
 * The description is the templated sentence rather than the generated one:
 * templates are assembled from the record and are certainly true, which is the
 * right property for text that will be quoted in places we do not control.
 */

const KIND_LABEL: Record<EventRecord['kind'], string> = {
  release: 'Release',
  'fork-spike': 'Fork activity above baseline',
  'fork-outlier': 'Fork activity above category',
  'demand-cluster': 'Demand',
  'dependency-shift': 'Dependency change',
  lineage: 'Lineage',
  correction: 'Correction',
};

export function eventPath(event: EventRecord): string {
  return `/e/${eventSlug(event.id)}`;
}

/** One sentence, safe to quote anywhere. Falls back to bare measurements. */
export function eventDescription(event: EventRecord): string {
  const templated = templatedSentence(event);
  if (templated !== null) return templated;

  const measures = Object.entries(event.metrics)
    .filter(([, value]) => value !== null && value !== '')
    .slice(0, 4)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1').toLowerCase()} ${String(value)}`)
    .join(', ');

  return measures === ''
    ? `${KIND_LABEL[event.kind]} recorded for ${event.repo}.`
    : `${KIND_LABEL[event.kind]} for ${event.repo}: ${measures}.`;
}

export function renderEventPage(
  event: EventRecord,
  index: IndexBundle,
  meta: MetaRecord,
): string {
  const measurements = Object.entries(event.metrics)
    .filter(([, value]) => value !== null && value !== '')
    .map(
      ([key, value]) => `<div class="metric">
      <span class="label">${esc(key.replace(/([A-Z])/g, ' $1'))}</span>
      <span class="metric-value num">${esc(String(value))}</span>
    </div>`,
    )
    .join('');

  // Generated prose stays visually apart from the measurements it explains.
  const prose = event.summary === null ? '' : `<p class="prose">${esc(event.summary)}</p>`;

  const description = eventDescription(event);

  const body = `
<section class="repo-head">
  <div class="repo-facts" style="padding-bottom:8px">
    <span class="label">${esc(KIND_LABEL[event.kind])}</span>
    ${stateBadge(event.confidence)}
    <span class="label">${esc(event.detectedAt.replace('T', ' ').slice(0, 16))} UTC</span>
  </div>
  <h1 class="repo-title">${esc(event.repo)}</h1>
  <div class="repo-facts">
    <a class="label" href="/repo/${esc(event.repo)}">All signals for this repository</a>
    <a class="label" href="${esc(event.evidenceUrl)}">Verify on GitHub</a>
  </div>
</section>

<div class="finding-metrics" style="padding-top:18px">${measurements}</div>
${prose}

<div class="notice">
  <strong>How to read this</strong>
  ${esc(description)}
  Every figure above is published as JSON at
  <a href="/data/${event.kind === 'release' ? 'ships' : event.kind === 'demand-cluster' ? 'demand' : event.kind === 'dependency-shift' ? 'stack' : 'forks'}.json">the lens bundle</a>,
  and the reading it came from can be checked at the source link.
</div>`;

  return layout({
    title: `${event.repo} — ${KIND_LABEL[event.kind]} — Readout`,
    current: '',
    index,
    meta,
    description,
    path: eventPath(event),
    body,
  });
}

/**
 * RSS, so the product can be followed rather than only remembered.
 *
 * Confirmed findings only. A detection that evaporates tomorrow should not
 * arrive in somebody's reader as news.
 */
export function renderFeed(events: readonly EventRecord[], generatedAt: string): string {
  const items = events
    .filter((event) => event.confidence === 'confirmed' && event.kind !== 'correction')
    .slice(0, 50)
    .map((event) => {
      const url = `${SITE_ORIGIN}${eventPath(event)}`;
      return `  <item>
    <title>${esc(`${event.repo} — ${KIND_LABEL[event.kind]}`)}</title>
    <link>${esc(url)}</link>
    <guid isPermaLink="true">${esc(url)}</guid>
    <pubDate>${new Date(event.detectedAt).toUTCString()}</pubDate>
    <description>${esc(eventDescription(event))}</description>
  </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Readout — confirmed findings</title>
  <link>${SITE_ORIGIN}/</link>
  <description>Release, fork, demand and dependency readings across watched open-source repositories. Confirmed findings only.</description>
  <language>en</language>
  <lastBuildDate>${new Date(generatedAt).toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>
`;
}

export function renderSitemap(paths: readonly string[]): string {
  const urls = paths
    .map((path) => `  <url><loc>${esc(`${SITE_ORIGIN}${path}`)}</loc></url>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function renderRobots(): string {
  return `User-agent: *
Allow: /

Sitemap: ${SITE_ORIGIN}/sitemap.xml
`;
}
