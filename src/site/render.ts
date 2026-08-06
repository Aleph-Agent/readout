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

/**
 * The answer box.
 *
 * Progressive enhancement, and strictly so: without scripting the form is
 * inert and says why, and every reading it could have described is on the page
 * underneath it anyway. Nothing here is the only route to anything.
 */
const ASK_SCRIPT = `
const form = document.getElementById('ask-form');
if (form) {
  const field = form.querySelector('input');
  const button = form.querySelector('button');
  const out = document.getElementById('ask-answer');
  form.hidden = false;

  for (const example of form.querySelectorAll('.ask-example')) {
    example.addEventListener('click', () => {
      field.value = example.textContent;
      form.requestSubmit();
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = field.value.trim();
    if (question === '') return;

    button.disabled = true;
    out.hidden = false;
    out.className = 'ask-answer ask-waiting';
    out.textContent = 'Reading the record…';

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      out.className = res.ok ? 'ask-answer' : 'ask-answer ask-declined';
      out.textContent = res.ok ? data.answer : data.error;
    } catch {
      out.className = 'ask-answer ask-declined';
      out.textContent = 'The answer box could not be reached. Every reading it draws on is on this page.';
    } finally {
      button.disabled = false;
    }
  });
}`.trim();

/** Questions that demonstrate the shape of what the record can answer. */
const ASK_EXAMPLES = [
  'What has released a new version recently?',
  'Which repositories gained the most forks?',
  'What can this instrument not tell me?',
];

function askHtml(): string {
  const examples = ASK_EXAMPLES.map(
    (question) => `<button type="button" class="ask-example">${esc(question)}</button>`,
  ).join('');

  return `<form class="ask" id="ask-form" hidden>
    <div class="ask-row">
      <input type="text" name="question" maxlength="280" autocomplete="off"
             aria-label="Ask a question about these readings"
             placeholder="Ask about the readings on this page…">
      <button type="submit">Ask</button>
    </div>
    <div class="ask-examples">${examples}</div>
  </form>
  <output class="ask-answer" id="ask-answer" hidden></output>
  <noscript><p class="notice">The answer box needs scripting. Everything it draws on is on this
  page and in <a href="/data/ask-context.json">the record it reads</a>.</p></noscript>`;
}

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
    ${resolved < 20 ? `That is ${resolved} findings, which is a small sample and should be read as one.` : ''}
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
<div class="backdrop" aria-hidden="true"></div>
${mastheadHtml(options.meta, options.index.disclosure)}
${navHtml(options.current, options.index.lenses)}
<main class="shell">
${options.body}
</main>
${colophonHtml(options.index, options.meta)}
<script>${AGE_SCRIPT}
${ASK_SCRIPT}</script>${analyticsHtml()}
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
    return `<div class="strip">
  <div class="notice">
    <strong>Baseline forming</strong>
    All ${marks.length} repositories are being measured, and none has a full observation window yet.
    The strip appears once there is deviation to draw. Until then there is nothing to show, which is
    different from showing nothing.
  </div>
</div>`;
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

      // A confirmed anomaly beats, and its period comes from its own
      // multiplier: the further above baseline, the faster. A quiet watchlist
      // has nothing beating at all, which is the honest state of a quiet
      // watchlist.
      const beat =
        cls === 'mark-confirmed' && mark.multiplier !== null
          ? ` style="--beat:${Math.max(0.6, 3 - Math.log1p(mark.multiplier) / 2).toFixed(2)}s"`
          : '';

      return `<rect class="${cls}"${beat} x="${x}" y="${(H - h).toFixed(2)}" width="${width.toFixed(3)}" height="${h.toFixed(2)}"><title>${esc(mark.name)} — ${esc(mark.state)}</title></rect>`;
    })
    .join('');

  const baselineY = (H - BASELINE_HEIGHT * H).toFixed(2);

  return `<div class="strip">
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
</div>`;
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

  return `<article class="finding finding-${esc(event.confidence)}">
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

/**
 * The watchlist itself, as a readout.
 *
 * The homepage was three grey notices and an empty chart, which reads as a
 * broken product rather than a working one. It was never short of data — 388
 * repositories were being measured every four hours and none of them appeared
 * anywhere. Density is what makes this look like an instrument, and the density
 * was already collected.
 *
 * Busiest first, so the top of the page is where something is happening.
 */
function watchlistReadout(marks: readonly StripMark[]): string {
  if (marks.length === 0) return '';

  const SHOWN = 40;
  const ranked = [...marks].sort(
    (a, b) => (b.delta ?? -1) - (a.delta ?? -1) || b.forks - a.forks,
  );

  const rows = ranked
    .slice(0, SHOWN)
    .map(
      (mark) => `<tr>
      <td><a href="/repo/${esc(mark.id)}">${esc(mark.name)}</a></td>
      <td class="dim">${esc(mark.category)}</td>
      <td class="dim">${esc(mark.language ?? '—')}</td>
      <td class="n num">${mark.forks.toLocaleString('en')}</td>
      <td class="n num">${mark.stars.toLocaleString('en')}</td>
      <td class="n num">${mark.delta === null ? '<span class="dim">—</span>' : mark.delta}</td>
      <td>${mark.state === 'quiet' ? '<span class="label dim">nominal</span>' : stateBadge(mark.state)}</td>
    </tr>`,
    )
    .join('');

  return `<div class="wrap"><table class="readout">
  <caption class="label">Watchlist — ${marks.length} repositories, busiest ${Math.min(SHOWN, marks.length)} shown</caption>
  <thead><tr>
    <th scope="col">Repository</th><th scope="col">Category</th><th scope="col">Language</th>
    <th scope="col" class="n">Forks</th><th scope="col" class="n">Stars</th>
    <th scope="col" class="n">Added</th><th scope="col">Reading</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="basis label">Added counts forks gained across the current observation window. A repository
whose window has not filled yet shows no figure rather than a zero.</p>`;
}

/**
 * A numbered band.
 *
 * The page was a stack of sections separated by hairlines, and nothing told a
 * reader where one reading stopped and the next began. Numbering them and
 * hanging the number and the name in a fixed left rail is how a panel is
 * labelled: the eye finds the same column every time, the numbers give the
 * page an order, and no section has to carry a heading inline.
 */
function band(no: string, name: string, inner: string, note?: string): string {
  if (inner.trim() === '') return '';

  return `<section class="band">
  <div class="band-rail">
    <span class="band-no num">${esc(no)}</span>
    <h2 class="band-name">${esc(name)}</h2>
  </div>
  <div class="band-body">${note === undefined ? '' : `<p class="band-note">${esc(note)}</p>`}
${inner}
  </div>
</section>`;
}

/** What each lens answers. The navigation named them and nothing explained them. */
const LENS_QUESTION: Record<LensName, string> = {
  ships: 'What released a new version?',
  forks: 'What is being copied faster than it usually is?',
  demand: 'What are developers asking for in more than one place?',
  stack: 'What dependencies are being added, dropped, or jumped?',
  lineage: 'Which models say they were built on which?',
};

function heroHtml(index: IndexBundle, meta: MetaRecord): string {
  const { watchlist, disclosure } = index;
  const findings = Object.values(index.lenses).reduce((total, lens) => total + lens.count, 0);

  return `<section class="hero">
  <h1 class="hero-thesis">An instrument pointed at <em>${watchlist.active} open-source repositories</em>.</h1>
  <p class="hero-sub">
    Every ${disclosure.cadenceHours} hours it reads what those projects are doing and writes the
    numbers down here, permanently. It compares each project against its own history rather than
    against anything else, links every figure to the place you can check it, and says plainly when
    it has nothing to report — which is most days, for most projects.
  </p>
  <div class="hero-figures">
    <div class="figure"><span class="figure-value num">${watchlist.active}</span><span class="label">Repositories watched</span></div>
    <div class="figure"><span class="figure-value num">5</span><span class="label">Signals read</span></div>
    <div class="figure"><span class="figure-value num">${disclosure.cadenceHours}h</span><span class="label">Between readings</span></div>
    <div class="figure"><span class="figure-value num">${findings}</span><span class="label">Findings on record</span></div>
    <div class="figure">
      <span class="figure-value num">${meta.lastSuccessfulRunAt === null ? '—' : esc(meta.lastSuccessfulRunAt.slice(11, 16))}</span>
      <span class="label">Last reading, UTC</span>
    </div>
  </div>
</section>`;
}

function lensesHtml(index: IndexBundle): string {
  const cells = NAV.filter((item) => item.lens !== null)
    .map((item) => {
      const lens = item.lens as LensName;
      const { status, count } = index.lenses[lens];
      return `<a class="lens-cell" href="${item.href}">
      <span class="lens-name">${esc(item.label)}</span>
      <span class="lens-question">${esc(LENS_QUESTION[lens])}</span>
      <span class="lens-count">${
        status === 'pending'
          ? 'not measured yet'
          : `${count} recorded${count === 0 ? ' — nothing has crossed the bar' : ''}`
      }</span>
    </a>`;
    })
    .join('');

  return `<div class="lens-grid">${cells}</div>`;
}

/**
 * What the watchlist is pointed at.
 *
 * "388 repositories" is a number nobody can picture. These five rows are the
 * answer to the question it leaves open — 388 of what — and every column is a
 * measurement with its window and its sample size stated, because a total with
 * no sample behind it is not a reading.
 */
function coverageHtml(index: IndexBundle): string {
  if (index.coverage.length === 0) return '';

  const rows = index.coverage
    .map(
      (row) => `<tr>
      <td>${esc(row.category)}</td>
      <td class="n num">${row.repositories}</td>
      <td class="n num">${row.measured === 0 ? '<span class="dim">—</span>' : row.measured}</td>
      <td class="n num">${row.forksAdded === null ? '<span class="dim">—</span>' : row.forksAdded.toLocaleString('en')}</td>
      <td class="n num">${row.findings}</td>
      <td>${row.busiest === null ? '<span class="dim">—</span>' : repoLink(row.busiest)}</td>
    </tr>`,
    )
    .join('');

  const totals = index.coverage.reduce(
    (sum, row) => ({
      repositories: sum.repositories + row.repositories,
      findings: sum.findings + row.findings,
    }),
    { repositories: 0, findings: 0 },
  );

  return `<div class="wrap"><table class="readout">
  <caption class="label">Coverage — ${index.coverage.length} categories, ${totals.repositories} repositories</caption>
  <thead><tr>
    <th scope="col">Category</th>
    <th scope="col" class="n">Watched</th>
    <th scope="col" class="n">Measured</th>
    <th scope="col" class="n">Forks added</th>
    <th scope="col" class="n">Findings</th>
    <th scope="col">Busiest</th>
  </tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr>
    <td class="label">All</td>
    <td class="n num">${totals.repositories}</td>
    <td class="n num" colspan="2"><span class="dim">—</span></td>
    <td class="n num">${totals.findings}</td>
    <td><span class="dim">—</span></td>
  </tr></tfoot>
</table></div>
<p class="basis label">Watched is the count being read now. Measured is how many of those have an
observation window long enough to compare, and Forks added is summed over those only — a category
with none shows no figure rather than a zero. Findings counts every reading ever published for a
repository in that category, including repositories since retired.</p>`;
}

/**
 * What the token is, stated before anyone has to ask.
 *
 * The rules here are strict and worth stating plainly: nothing about price,
 * nothing about appreciation, no wallet-connect, and no claim that holding it
 * grants anything. What it actually is, is a funding mechanism — and saying so
 * is more defensible than implying utility that does not exist.
 */
function tokenHtml(): string {
  return `<div class="token">
  <p>
    This project is funded by a token on Robinhood Chain. Trading it pays a fee, and most of that
    fee goes to whoever launched the pool — which is what pays for this to keep running and to stay
    free to read.
  </p>
  <p>
    That is the whole of it. Holding it does not unlock anything here, there is nothing to connect a
    wallet to, and no part of this site is behind it. Every reading, every bundle and every archive
    is public and always will be.
  </p>
  <p>
    It has not launched. The plan is to run this in the open first, see which of the five readings
    people actually find worth sharing, and name it after the answer rather than after a guess. When
    it does launch, the contract address will appear here and nowhere else.
  </p>
</div>`;
}

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
    body: `${heroHtml(index, meta)}
${band('01', 'Ask', askHtml(), 'Answered from the readings below and from nothing else. Any figure not in the record is discarded rather than smoothed over.')}
${band('02', 'Readings', lensesHtml(index), 'What each of the five readings answers, and how many findings each has on record.')}
${band('03', 'Coverage', coverageHtml(index), 'What the watchlist is pointed at. A category is the reason a repository is watched, chosen by hand — it is not a fact about the repository and not a survey of that field.')}
${band('04', 'Fork velocity', stripSvg(index.strip, releasedToday), `One mark per repository, each measured against its own trailing baseline rather than against the others.`)}
${band('05', 'Today', `${table}${formingNotice}`, 'Everything detected since midnight UTC. Empty is the ordinary state and is reported as such.')}
${band('06', 'Watchlist', watchlistReadout(index.strip), 'Every repository being read, ordered by what it gained across the current window.')}
${band('07', 'Our record', scorecardHtml(index), 'How often this instrument has been right, published whatever it says.')}
${band('08', 'The token', tokenHtml(), 'What funds this, stated before anyone has to ask.')}`,
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
