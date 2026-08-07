import { basisHtml, esc, eventSlug, layout, proseHtml, SITE_ORIGIN, stateBadge } from './render.ts';
import { readingsOf } from './vocabulary.ts';
import { templatedSentence } from '../lib/validate.ts';
import type { IndexBundle } from '../types/bundles.ts';
import { isRepositorySubject, type EventRecord } from '../types/events.ts';
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
  licence: 'Licence change',
  archived: 'Archived',
  'model-price': 'Model price change',
  'model-withdrawn': 'Model withdrawn',
  'eol-approaching': 'End of life',
  correction: 'Correction',
};

export function eventPath(event: EventRecord): string {
  return `/e/${eventSlug(event.id)}`;
}

/**
 * The published file each kind's figures live in.
 *
 * Not every kind is a lens. Model prices and end-of-life dates have bundles of
 * their own, and pointing a reader at `forks.json` for a date they read on a
 * page about Python is an invitation to conclude the site made it up.
 */
function bundleOf(kind: EventRecord['kind']): string {
  if (kind === 'release') return 'ships';
  if (kind === 'demand-cluster') return 'demand';
  if (kind === 'dependency-shift') return 'stack';
  if (kind === 'model-price' || kind === 'model-withdrawn') return 'models';
  if (kind === 'eol-approaching') return 'eol';
  return 'forks';
}

/** Where a reader goes to check, named by where it actually goes. */
function verifyLabel(url: string): string {
  const host = /^https?:\/\/([^/]+)/.exec(url)?.[1]?.replace(/^www\./, '');
  if (host === undefined) return 'Verify at the source';
  if (host === 'github.com') return 'Verify on GitHub';
  return `Verify at ${host}`;
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
  const measurements = readingsOf(event)
    .map(
      (reading) => `<div class="metric">
      <span class="label">${esc(reading.label)}</span>
      <span class="metric-value num">${esc(reading.value)}</span>
    </div>`,
    )
    .join('');

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
    ${
      isRepositorySubject(event.kind)
        ? `<a class="label" href="/repo/${esc(event.repo)}">All signals for this repository</a>`
        : ''
    }
    <a class="label" href="${esc(event.evidenceUrl)}">${esc(verifyLabel(event.evidenceUrl))}</a>
  </div>
  ${basisHtml(event)}
</section>

<div class="finding-metrics" style="padding-top:18px">${measurements}</div>
${proseHtml(event)}

<div class="notice">
  <strong>How to read this</strong>
  ${esc(description)}
  Every figure above is published as JSON at
  <a href="/data/${bundleOf(event.kind)}.json">the bundle it came from</a>,
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
export function renderFeed(
  events: readonly EventRecord[],
  generatedAt: string,
  /**
   * One repository, when this is that repository's own feed.
   *
   * The site-wide feed is 400 projects of noise to somebody who depends on one
   * of them. A per-repository feed is the version a maintainer or a dependent
   * would actually keep subscribed, and it costs one static file each.
   */
  scope?: { repo: string; path: string },
): string {
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

  const title =
    scope === undefined ? 'Readout — confirmed findings' : `Readout — ${scope.repo}`;
  const description =
    scope === undefined
      ? 'Release, fork, demand and dependency readings across watched open-source repositories. Confirmed findings only.'
      : `Confirmed release, fork, demand and dependency readings for ${scope.repo}.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(title)}</title>
  <link>${SITE_ORIGIN}${scope === undefined ? '/' : scope.path}</link>
  <description>${esc(description)}</description>
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
