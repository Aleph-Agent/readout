import { COMPARISON, isCapped, readingsOf, SIGNAL_LABEL } from './vocabulary.ts';
import type { Disclosure, IndexBundle, LensBundle, LensName, StripMark } from '../types/bundles.ts';
import type { EventRecord } from '../types/events.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * Static HTML generation.
 *
 * Pages are rendered at build time from the same bundles the site publishes,
 * so there is no loading state, no client-side fetch, and nothing to render
 * empty while a request is in flight. The only script on the page computes
 * the age of a timestamp, which no static file can know on its own.
 */

export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Links are extensionless.
 *
 * Pages serves `ships.html` at `/ships` and answers `/ships.html` with a 308 to
 * the same place. Writing the extension into every href would put a redirect in
 * front of every navigation in the product. The files on disk keep their `.html`
 * names — that is what Pages resolves against — but nothing links to them that
 * way.
 */
const NAV: { href: string; label: string; lens: LensName | null }[] = [
  { href: '/', label: 'Index', lens: null },
  { href: '/ships', label: 'Ships', lens: 'ships' },
  { href: '/forks', label: 'Forks', lens: 'forks' },
  { href: '/demand', label: 'Demand', lens: 'demand' },
  { href: '/stack', label: 'Stack', lens: 'stack' },
  { href: '/lineage', label: 'Lineage', lens: 'lineage' },
];

/**
 * Reads a timestamp's age into the page.
 *
 * The absolute UTC time is rendered server-side and is always correct. This
 * only adds the relative age and the staleness warning, both of which depend on
 * when the page is being read rather than when it was built. Without scripting
 * the reader still gets the exact reading time, which is the part that matters.
 */
const AGE_SCRIPT = `
for (const el of document.querySelectorAll('[data-at]')) {
  const at = Date.parse(el.dataset.at);
  if (!Number.isFinite(at)) continue;
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  const h = Math.floor(mins / 60);
  el.textContent = (h > 0 ? h + 'h ' : '') + (mins % 60) + 'm ago';
  const limit = Number(el.dataset.staleAfter || 0);
  if (limit && mins > limit) {
    el.classList.add('stale');
    el.textContent += ' — past the expected cadence';
  }
}`.trim();

function navHtml(current: string, lenses: IndexBundle['lenses']): string {
  const items = NAV.map((item) => {
    const pending = item.lens !== null && lenses[item.lens].status === 'pending';
    const attrs = [
      `href="${item.href}"`,
      item.href === current ? 'aria-current="page"' : '',
      pending ? 'data-pending="true" title="No collector for this signal yet"' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<li><a ${attrs}>${esc(item.label)}</a></li>`;
  }).join('');

  return `<nav aria-label="Signals"><ul class="nav shell">${items}</ul></nav>`;
}

function mastheadHtml(meta: MetaRecord, disclosure: Disclosure): string {
  const at = meta.lastSuccessfulRunAt;
  const staleAfter = disclosure.cadenceHours * 2 * 60;

  const reading =
    at === null
      ? '<strong>No reading yet</strong>'
      : `<strong>${esc(at.replace('T', ' ').slice(0, 16))} UTC</strong>`;

  const age =
    at === null
      ? ''
      : `<span data-at="${esc(at)}" data-stale-after="${staleAfter}">age unavailable without scripting</span>`;

  return `<header class="masthead shell">
  <a class="wordmark" href="/">Readout</a>
  <div class="reading-age">
    <span><span class="label">Last reading</span> ${reading}</span>
    ${age}
  </div>
</header>`;
}

/**
 * The project's own record, stated whatever it says.
 *
 * A low rate is information about the detector, and a reader deserves it before
 * being asked to believe the next finding.
 */
function scorecardHtml(index: IndexBundle): string {
  const { resolved, followed, rate, windowDays, pending } = index.scorecard;

  if (rate === null) {
    return `<div class="notice">
      <strong>Our own record</strong>
      ${resolved} confirmed fork ${resolved === 1 ? 'finding has' : 'findings have'} been resolved so
      far${pending === 0 ? '' : `, with ${pending} still inside the ${windowDays}-day window`}. Too
      few to state a rate. It will appear here once there are enough, whatever it turns out to be.
    </div>`;
  }

  return `<div class="notice">
    <strong>Our own record</strong>
    Of ${resolved} confirmed fork findings, ${followed} were followed by a release from the same
    repository within ${windowDays} days — ${(rate * 100).toFixed(0)}%.
    ${pending === 0 ? '' : `${pending} more are still inside the window.`}
    This measures co-occurrence, not cause, and it is published whatever it says.
  </div>`;
}

function colophonHtml(index: IndexBundle, meta: MetaRecord): string {
  const { disclosure, watchlist } = index;

  const partial =
    meta.partial && meta.collectorsErrored.length > 0
      ? `<p>The most recent run was partial. ${esc(String(meta.collectorsErrored.length))} collector ${meta.collectorsErrored.length === 1 ? 'error was' : 'errors were'} recorded; the sections above show what was collected.</p>`
      : '';

  return `<footer class="colophon shell">
  <p>${watchlist.active} repositories are checked every ${disclosure.cadenceHours} hours. The watchlist is
  curated and partial — it is chosen by hand and is not a survey of open source.</p>
  <p>Fork activity is compared against each repository's own trailing baseline. A repository needs
  ${disclosure.minBaselineDays} days of history before any comparison is made; until then its counts are
  shown raw and marked forming.</p>
  <p>This data is not real-time. Every figure links to its source so it can be checked directly.
  The underlying bundles are published at <a href="/data/index.json">/data/index.json</a>.</p>
  ${partial}
</footer>`;
}

/** Absolute origin, needed because link previews reject relative URLs. */
export const SITE_ORIGIN = process.env['SITE_ORIGIN'] ?? 'https://readout-7pt.pages.dev';

/**
 * Cloudflare Web Analytics beacon tag.
 *
 * Not a credential — it is visible in the page source of every site that uses
 * one, and it grants nothing. Kept in an environment variable only so the
 * script is absent entirely until analytics is actually set up, rather than
 * shipping a broken tag.
 *
 * This is the one third-party request on the read path. It is here because the
 * project has to answer which lens people actually open before it can name
 * anything after the answer, and that question cannot be answered from static
 * files alone.
 */
const BEACON_TOKEN = process.env['CF_BEACON_TOKEN'] ?? '';

function analyticsHtml(): string {
  if (BEACON_TOKEN === '') return '';
  // Shape matches what Cloudflare currently hands out. A module script defers
  // by default, so it never blocks the page it is measuring.
  return `\n<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${esc(BEACON_TOKEN)}"}'></script>`;
}

export interface PageOptions {
  title: string;
  current: string;
  index: IndexBundle;
  meta: MetaRecord;
  body: string;
  /** One sentence for search results and link previews. */
  description?: string;
  /** Canonical path, e.g. `/e/release-ollama-ollama-v0-1`. */
  path?: string;
}

/**
 * A filesystem- and URL-safe name for an event.
 *
 * Event ids carry colons and slashes — `release:ollama/ollama:v0.12.1` — which
 * are meaningful in the id and unusable in a path.
 */
export function eventSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function layout(options: PageOptions): string {
  const description =
    options.description ??
    `Release, fork, demand, dependency and lineage readings across ${options.index.watchlist.active} open-source repositories.`;
  const url = `${SITE_ORIGIN}${options.path ?? '/'}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Readout">
<meta property="og:title" content="${esc(options.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(options.title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="alternate" type="application/rss+xml" title="Readout findings" href="/feed.xml">
<link rel="stylesheet" href="/site.css">
</head>
<body>
${mastheadHtml(options.meta, options.index.disclosure)}
${navHtml(options.current, options.index.lenses)}
<main class="shell">
${options.body}
</main>
${colophonHtml(options.index, options.meta)}
<script>${AGE_SCRIPT}</script>${analyticsHtml()}
</body>
</html>
`;
}

// --------------------------------------------------------------- the strip

const STRIP_CAP = 50;

/** Log scale, so ordinary activity reads as a low comb and a spike stands out. */
function markHeight(multiplier: number | null): number {
  if (multiplier === null) return 0.06;
  const scaled = Math.log1p(Math.max(0, multiplier)) / Math.log1p(STRIP_CAP);
  return Math.min(1, Math.max(0.03, scaled));
}

/** Where a multiplier of 1 — this repository behaving normally — sits. */
const BASELINE_HEIGHT = markHeight(1);

/**
 * The velocity strip: one mark per watched repository, ordered consistently so
 * its shape is comparable from one day to the next.
 *
 * The baseline is drawn explicitly. A comparison the reader cannot see the
 * reference for is not a measurement they can check.
 */
export function stripSvg(marks: readonly StripMark[], releasedToday: ReadonlySet<string>): string {
  if (marks.length === 0) return '';

  // Before any window has filled, every mark is the same height and the same
  // colour: fifty kilobytes of SVG saying nothing. Say it in a sentence
  // instead, and bring the chart back when there is something to chart.
  const measured = marks.filter((mark) => mark.state !== 'forming');
  if (measured.length === 0) {
    return `<section class="strip">
  <h2 class="label">Fork velocity</h2>
  <div class="notice">
    <strong>Baseline forming</strong>
    All ${marks.length} repositories are being measured, and none has a full observation window yet.
    The strip appears once there is deviation to draw. Until then there is nothing to show, which is
    different from showing nothing.
  </div>
</section>`;
  }

  const H = 100;
  const step = 100 / marks.length;
  const width = Math.max(step * 0.55, 0.12);

  const bars = marks
    .map((mark, i) => {
      const h = markHeight(mark.multiplier) * H;
      const x = (i * step).toFixed(3);

      // Anomaly outranks activity. A repository that is both spiking and
      // shipping must read as spiking: painting it with the nominal colour
      // would hide the reading behind the healthier-looking one.
      const cls =
        mark.state === 'forming'
          ? 'mark-forming'
          : mark.state === 'confirmed'
            ? 'mark-confirmed'
            : mark.state === 'detected'
              ? 'mark-detected'
              : releasedToday.has(mark.id)
                ? 'mark-growth'
                : 'mark-quiet';

      return `<rect class="${cls}" x="${x}" y="${(H - h).toFixed(2)}" width="${width.toFixed(3)}" height="${h.toFixed(2)}"><title>${esc(mark.id)} — ${esc(mark.state)}</title></rect>`;
    })
    .join('');

  const baselineY = (H - BASELINE_HEIGHT * H).toFixed(2);

  return `<section class="strip" aria-labelledby="strip-h">
  <h2 class="label" id="strip-h">Fork velocity — ${marks.length} repositories, each against its own baseline</h2>
  <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" role="img"
       aria-label="One mark per watched repository. Height is deviation from that repository's own fork baseline. ${marks.filter((m) => m.state === 'confirmed').length} confirmed above baseline.">
    <line class="baseline-rule" x1="0" y1="${baselineY}" x2="100" y2="${baselineY}"></line>
    ${bars}
  </svg>
  <div class="strip-scale">
    <span class="label">First by name</span>
    <span class="label">Dashed line = this repository's normal</span>
    <span class="label">Last by name</span>
  </div>
  <div class="strip-legend">
    <span class="state state-confirmed">Confirmed spike</span>
    <span class="state state-detected">Detected once</span>
    <span class="state state-forming">Baseline forming</span>
  </div>
</section>`;
}

// ---------------------------------------------------------------- fragments

export function stateBadge(state: string): string {
  const known = state === 'confirmed' || state === 'detected' || state === 'forming';
  const cls = known ? `state state-${state}` : 'state state-forming';
  return `<span class="${cls}">${esc(state)}</span>`;
}

function repoLink(repo: string): string {
  return `<a href="/repo/${esc(repo)}">${esc(repo)}</a>`;
}

function timeOf(iso: string): string {
  return esc(iso.slice(11, 16));
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span class="label">${esc(label)}</span><span class="metric-value num">${esc(value)}</span></div>`;
}

/**
 * The only card in the product: a confirmed event that has prose attached.
 * Everything else is a table row.
 */
/**
 * A sentence, and where it came from.
 *
 * A template restates the record and is certainly true. A model sentence is a
 * reading of it. They arrived in the same typeface with nothing to tell them
 * apart, which is precisely the distinction the reader most needs.
 */
export function proseHtml(event: EventRecord): string {
  if (event.summary === null) return '';

  const written = event.summarySource === 'model';
  return `<div class="explains ${written ? 'explains-written' : 'explains-assembled'}">
  <p class="prose">${esc(event.summary)}</p>
  <span class="label">${written ? 'Written from the readings above' : 'Assembled from the readings above'}</span>
</div>`;
}

/** The comparison a finding rests on, stated rather than left to be inferred. */
export function basisHtml(event: EventRecord): string {
  const basis = COMPARISON[event.kind];
  if (basis === undefined) return '';
  const capped = isCapped(event) ? ' The figure shown is a bound, not a measurement.' : '';
  return `<p class="basis label">${esc(basis)}.${esc(capped)}</p>`;
}

function findingCard(event: EventRecord): string {
  const numbers = readingsOf(event)
    .slice(0, 5)
    .map((reading) => metric(reading.label, reading.value))
    .join('');

  return `<article class="finding">
  <div class="finding-head">
    <span class="finding-repo">${repoLink(event.repo)}</span>
    <span class="label">${esc(SIGNAL_LABEL[event.kind])}</span>
    ${stateBadge(event.confidence)}
    <a class="label" href="/e/${esc(eventSlug(event.id))}">${esc(event.detectedAt.replace('T', ' ').slice(0, 16))} UTC</a>
    <a class="label" href="${esc(event.evidenceUrl)}">Evidence</a>
  </div>
  ${basisHtml(event)}
  <div class="finding-metrics">${numbers}</div>
  ${proseHtml(event)}
</article>`;
}

function quietNotice(checked: number, at: string | null, what: string): string {
  return `<div class="notice">
  <strong>Nothing crossed the threshold</strong>
  ${checked} repositories were checked${at === null ? '' : ` at ${esc(at.replace('T', ' ').slice(0, 16))} UTC`}
  and no ${esc(what)} met the reporting bar. A quiet reading is a reading.
</div>`;
}

function pendingNotice(lens: string): string {
  return `<div class="notice">
  <strong>Not measured yet</strong>
  No collector produces ${esc(lens)} signals so far. This page is empty because nothing has been
  observed, not because nothing happened.
</div>`;
}

// -------------------------------------------------------------------- pages

export function renderIndex(index: IndexBundle, meta: MetaRecord): string {
  const releasedToday = new Set(
    index.today.filter((event) => event.kind === 'release').map((event) => event.repo),
  );

  const rows = index.today
    .map(
      (event) => `<tr>
      <td class="dim">${timeOf(event.detectedAt)}</td>
      <td>${repoLink(event.repo)}</td>
      <td><span class="label">${esc(event.kind)}</span></td>
      <td>${stateBadge(event.confidence)}</td>
      <td>${esc(String(event.metrics['tag'] ?? event.metrics['multiplier'] ?? '—'))}</td>
      <td class="dim"><a href="${esc(event.evidenceUrl)}">source</a></td>
    </tr>`,
    )
    .join('');

  const table =
    index.today.length === 0
      ? quietNotice(index.watchlist.active, meta.lastSuccessfulRunAt, 'signal')
      : `<div class="wrap"><table class="readout">
      <caption class="label">Today — ${index.today.length} signals</caption>
      <thead><tr><th scope="col">UTC</th><th scope="col">Repository</th><th scope="col">Signal</th><th scope="col">Confidence</th><th scope="col">Reading</th><th scope="col">Link</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  const forming = index.strip.filter((m) => m.state === 'forming').length;
  const formingNotice =
    forming === 0
      ? ''
      : `<div class="notice"><strong>Baseline forming</strong>
      ${forming} of ${index.strip.length} repositories have under ${index.disclosure.minBaselineDays} days of history.
      Their counts are shown raw; no multiplier is computed for them and none is implied.</div>`;

  return layout({
    title: 'Readout — developer activity readings',
    current: '/',
    index,
    meta,
    body: `${stripSvg(index.strip, releasedToday)}\n${table}\n${formingNotice}\n${scorecardHtml(index)}`,
  });
}

export function renderLens(
  bundle: LensBundle,
  index: IndexBundle,
  meta: MetaRecord,
  copy: { title: string; heading: string; noun: string; scope?: string },
  archives = '',
): string {
  let body: string;

  if (bundle.status === 'pending') {
    body = pendingNotice(copy.noun);
  } else if (bundle.records.length === 0) {
    body = quietNotice(index.watchlist.active, meta.lastSuccessfulRunAt, copy.noun);
  } else {
    body = bundle.records.map(findingCard).join('\n');
  }

  // Scope sits above the findings, not in a footnote. A reader who takes one of
  // these as a statement about open source generally has been misled, and where
  // the note appears decides whether that happens.
  const scope =
    copy.scope === undefined
      ? ''
      : `<div class="notice"><strong>What this covers</strong>${esc(copy.scope)}</div>`;

  // Retractions are disclosed by count. Hiding them would be dishonest;
  // rendering one card each would bury the surviving findings under the
  // mistake. Both records stay in the published event ledger either way.
  const withdrawn =
    bundle.withdrawn === 0
      ? ''
      : `<div class="notice notice-alert"><strong>Withdrawn</strong>
        ${bundle.withdrawn} earlier ${bundle.withdrawn === 1 ? 'finding has' : 'findings have'} been
        retracted and are not shown. Both the original and the retraction remain in the
        <a href="/data/${esc(bundle.lens)}.json">published ledger</a>.</div>`;

  return layout({
    title: copy.title,
    current: `/${bundle.lens}`,
    index,
    meta,
    body: `<h1 class="label" style="padding:22px 0 4px">${esc(copy.heading)} — last ${bundle.windowDays} days, ${bundle.count} recorded</h1>\n${scope}\n${withdrawn}\n${body}\n${archives}`,
  });
}
