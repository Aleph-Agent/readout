import { COMPARISON, isCapped, readingsOf, SIGNAL_LABEL } from './vocabulary.ts';
import { REACHABLE_SHARE } from '../lib/calibration.ts';
import { MIN_INSTALLS } from '../lib/divergence.ts';
import { COMPARE_SCRIPT } from './compare.ts';
import { STACK_SCRIPT } from './stack.ts';
import type { IndexBundle, LensBundle, LensName, StripMark } from '../types/bundles.ts';
import { isRepositorySubject, type EventRecord } from '../types/events.ts';
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
  { href: '/live', label: 'Live', lens: null },
  { href: '/ships', label: 'Ships', lens: 'ships' },
  { href: '/forks', label: 'Forks', lens: 'forks' },
  { href: '/demand', label: 'Demand', lens: 'demand' },
  { href: '/stack', label: 'Stack', lens: 'stack' },
  { href: '/lineage', label: 'Lineage', lens: 'lineage' },
  // How it works, what it cannot do, and who is paying. It was all in the
  // commit log, which is a credibility argument aimed at an audience that does
  // not read strangers' commit logs.
  // The tools sit after the readings: a visitor who does not know what this
  // measures has no use for a tool that measures it.
  { href: '/stack', label: 'Your stack', lens: null },
  { href: '/models', label: 'Models', lens: null },
  { href: '/incidents', label: 'Status', lens: null },
  { href: '/ecosystem', label: 'Ecosystem', lens: null },
  { href: '/findings', label: 'Findings', lens: null },
  { href: '/week', label: 'This week', lens: null },
  { href: '/depends', label: 'Depended on', lens: null },
  { href: '/compare', label: 'Compare', lens: null },
  { href: '/method', label: 'Method', lens: null },
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
/**
 * Counts the headline figure up to its value, once.
 *
 * The magnitude is the whole point of that number and reading "4,432,665,399"
 * does not convey it — watching it climb does. Progressive enhancement in the
 * strict sense: the final value is already in the HTML, and this only replaces
 * it for the duration of the animation, so without scripting nothing is lost.
 *
 * Skipped entirely under reduced motion rather than shortened, because a
 * count-up shortened to nothing is a flicker.
 */
const COUNT_SCRIPT = `
const counter = document.querySelector('[data-count]');
if (counter && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const target = Number(counter.dataset.count);
  if (Number.isFinite(target) && target > 0) {
    const format = new Intl.NumberFormat('en');
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 1400);
      // Eases out hard, so most of the climb happens early and the last digits
      // settle rather than race.
      const eased = 1 - Math.pow(1 - t, 4);
      counter.textContent = format.format(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}`.trim();

/** Copy buttons. Confirms in place, because a click with no feedback reads as broken. */
const COPY_SCRIPT = `
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      const was = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = was; }, 1600);
    } catch {
      // Clipboard refused — usually an insecure context. The text is on the
      // page and selectable, so say nothing rather than pretending it worked.
    }
  });
}`.trim();

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

/**
 * The chrome: wordmark, reading age, theme switch, navigation.
 *
 * One sticky bar rather than two static blocks. The navigation used to scroll
 * away on a page of four hundred rows, which meant the only way back to another
 * signal was to scroll to the top first.
 *
 * It is also the only place in the product allowed the glass material — see
 * `.chrome` in the stylesheet for why, and why nothing holding a number may
 * follow it there.
 */
function chromeHtml(current: string, meta: MetaRecord, index: IndexBundle): string {
  const at = meta.lastSuccessfulRunAt;
  const staleAfter = index.disclosure.cadenceHours * 2 * 60;

  const reading =
    at === null
      ? '<strong>No reading yet</strong>'
      : `<strong>${esc(at.replace('T', ' ').slice(0, 16))} UTC</strong>`;

  const age =
    at === null
      ? ''
      : `<span data-at="${esc(at)}" data-stale-after="${staleAfter}">age unavailable without scripting</span>`;

  return `<header class="chrome">
  <div class="shell chrome-bar">
    <a class="wordmark" href="/">Sighttrue</a>
    <div class="reading-age">
      <span><span class="label">Last reading</span> ${reading}</span>
      ${age}
    </div>
    <button class="theme-switch" type="button" data-theme-switch hidden
      aria-label="Switch between the dark and light theme">
      <span class="theme-track" aria-hidden="true"><span class="theme-thumb"></span></span>
      <span data-theme-name>Dark</span>
    </button>
  </div>
  ${navHtml(current, index.lenses)}
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

/**
 * Whether the bar can be reached at all.
 *
 * The scorecard above says how often confirmed findings held up. It cannot say
 * anything about the findings that were never made, and a detector set too high
 * produces a perfect scorecard by producing nothing. This is the other half:
 * how close everything got, whether or not it crossed.
 */
function calibrationHtml(index: IndexBundle): string {
  if (index.calibration.length === 0) {
    return `<div class="notice">
      <strong>Calibration not yet recorded</strong>
      Nothing has been measured against a threshold yet, so there is no evidence either way about
      whether these detectors are set within reach. The first daily run that measures anything
      starts this record, and it is published from then on whatever it says.
    </div>`;
  }

  const rows = index.calibration
    .map((row) => {
      const share =
        row.peakShare === null
          ? '<span class="dim">—</span>'
          : `${(row.peakShare * 100).toFixed(0)}%`;

      // A detector nothing has come close to is not quiet, it is a detector
      // nobody has evidence for. Saying so is the entire purpose of the table.
      const reading =
        row.measured === 0
          ? '<span class="state state-forming">Nothing measured</span>'
          : row.crossed > 0
            ? '<span class="state state-confirmed">Reached</span>'
            : row.peakShare !== null && row.peakShare < REACHABLE_SHARE
              ? '<span class="state state-forming">Never approached</span>'
              : '<span class="state state-detected">Approached</span>';

      return `<tr>
      <td>${esc(row.collector)}</td>
      <td class="dim">${esc(row.metric)}</td>
      <td class="n num">${row.threshold}</td>
      <td class="n num">${row.peak === null ? '<span class="dim">—</span>' : row.peak}</td>
      <td class="n num">${share}</td>
      <td class="n num">${row.measured.toLocaleString('en')}</td>
      <td class="n num">${row.crossed}</td>
      <td>${reading}</td>
    </tr>`;
    })
    .join('');

  const days = Math.max(...index.calibration.map((row) => row.days));

  return `<div class="wrap"><table class="readout">
  <caption class="label">Calibration — ${index.calibration.length} detectors, ${days} ${days === 1 ? 'day' : 'days'} on record</caption>
  <thead><tr>
    <th scope="col">Detector</th>
    <th scope="col">Compares</th>
    <th scope="col" class="n">Bar</th>
    <th scope="col" class="n">Highest seen</th>
    <th scope="col" class="n">Of bar</th>
    <th scope="col" class="n">Measured</th>
    <th scope="col" class="n">Crossed</th>
    <th scope="col">Reading</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="basis label">Never approached means nothing reached half the bar — a fault in this
instrument, not in the repositories. <a href="/method">How</a></p>`;
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
export const SITE_ORIGIN = process.env['SITE_ORIGIN'] ?? 'https://sighttrue.com';

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

/**
 * Runs before the first paint, which is the whole reason it is inline.
 *
 * Deferred, this would repaint the page from dark to light in front of somebody
 * who chose light, and a flash of the wrong theme on every navigation is worse
 * than not offering the choice. Nothing else in the product blocks rendering.
 *
 * Only a stored choice is applied here. With nothing stored the attribute stays
 * off and `color-scheme: light dark` lets the system decide, so a visitor who
 * has never touched the switch gets their own preference with no script
 * involved at all.
 */
const THEME_BOOT =
  "try{var t=localStorage.getItem('readout-theme');" +
  "if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}";

export interface PageOptions {
  title: string;
  /**
   * Feed this page belongs to. Defaults to the site-wide one.
   *
   * A repository page pointing at the site feed hands a reader four hundred
   * projects when they asked to follow one, which is how a feed link gets
   * clicked once and never again.
   */
  feed?: { href: string; title: string };
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

/**
 * Every behaviour on the site, in one cached file.
 *
 * These were inlined into each page, which cost 12.6KB on all 653 of them —
 * 8.25MB of identical script, most of it on repository pages that use none of
 * it. One external file is fetched once and cached for every page after,
 * and each block no-ops when the element it looks for is absent.
 *
 * Deferred rather than inline, so nothing here blocks rendering. Every feature
 * built on it degrades to the static HTML underneath: the ages are already
 * absolute UTC, the headline figure is already its final value, and the two
 * tools say plainly that they need scripting.
 */
/**
 * The theme switch.
 *
 * The inline boot script has already applied any stored choice, so all this
 * does is reveal the control, keep its label truthful, and write the choice
 * down. Revealing it here rather than in the markup means a reader with no
 * scripting never sees a switch that cannot switch anything — their system
 * preference is already being honoured by `color-scheme: light dark`, with no
 * control to mislead them about it.
 */
const THEME_SCRIPT = `
(function () {
  var button = document.querySelector('[data-theme-switch]');
  if (!button) return;

  var name = button.querySelector('[data-theme-name]');
  var root = document.documentElement;

  function current() {
    if (root.dataset.theme === 'light' || root.dataset.theme === 'dark') return root.dataset.theme;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function show() {
    var theme = current();
    if (name) name.textContent = theme === 'light' ? 'Light' : 'Dark';
    button.setAttribute(
      'aria-label',
      'Colour theme: ' + theme + '. Switch to ' + (theme === 'light' ? 'dark' : 'light') + '.'
    );
  }

  button.hidden = false;
  show();

  button.addEventListener('click', function () {
    var next = current() === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    show();
    try { localStorage.setItem('readout-theme', next); } catch (e) {}
  });

  // Somebody who has never used the switch is following their system, so the
  // label has to follow it too when it changes under them.
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
    if (!root.dataset.theme) show();
  });
})();`;

export const SITE_SCRIPT = [
  THEME_SCRIPT,
  AGE_SCRIPT,
  COUNT_SCRIPT,
  COPY_SCRIPT,
  ASK_SCRIPT,
  COMPARE_SCRIPT,
  STACK_SCRIPT,
].join('\n\n');

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
<meta property="og:site_name" content="Sighttrue">
<meta property="og:title" content="${esc(options.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE_ORIGIN}/share.png">
<meta property="og:image:width" content="1500">
<meta property="og:image:height" content="500">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE_ORIGIN}/share.png">
<meta name="twitter:title" content="${esc(options.title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="alternate" type="application/rss+xml" title="${esc(options.feed?.title ?? 'Sighttrue findings')}" href="${esc(options.feed?.href ?? '/feed.xml')}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
<script>${THEME_BOOT}</script>
</head>
<body>
<div class="backdrop" aria-hidden="true"></div>
${chromeHtml(options.current, options.meta, options.index)}
<main class="shell">
${options.body}
</main>
${colophonHtml(options.index, options.meta)}
<script src="/site.js" defer></script>${analyticsHtml()}
</body>
</html>
`;
}

// --------------------------------------------------------------- the strip

const STRIP_CAP = 50;

/** Log scale, so ordinary activity reads as a low comb and a spike stands out. */
function markHeight(multiplier: number | null): number {
  // Unmeasured marks are drawn low but visible. Tall enough that four hundred
  // of them read as an instrument at rest; short enough that they can never be
  // mistaken for a reading, which the outline stroke also guards against.
  if (multiplier === null) return 0.16;
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

  // This used to refuse to draw until something deviated, on the grounds that a
  // flat comb is fifty kilobytes of SVG saying nothing. That reasoning was
  // about information and it cost the product its face: for the first fourteen
  // days the page had no chart, no image, and nothing a reader would remember.
  //
  // A comb of outline marks is not nothing. It says: these are being measured,
  // this is where normal sits, and none of them has moved off it. Drawn as
  // outlines rather than filled bars so "not measured yet" never looks like
  // "measured at zero", and labelled as forming underneath.
  const measured = marks.filter((mark) => mark.state !== 'forming');
  const forming = measured.length === 0;

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

      // Hover titles carry a repository name, which is worth 40 bytes on a
      // mark that has a reading. On a forming mark the title would say the
      // same thing 388 times over — the caption already says it once — and 15KB
      // of identical tooltips is not an accessibility feature. The aria-label
      // and the table underneath are the accessible path either way.
      const title =
        mark.state === 'forming'
          ? ''
          : `<title>${esc(mark.name)} — ${esc(mark.state)}</title>`;

      return `<rect class="${cls}"${beat} x="${x}" y="${(H - h).toFixed(1)}" width="${width.toFixed(3)}" height="${h.toFixed(1)}">${title}</rect>`;
    })
    .join('');

  const baselineY = (H - BASELINE_HEIGHT * H).toFixed(2);

  return `<figure class="strip${forming ? ' strip-forming' : ''}">
  <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" role="img"
       aria-label="One mark per watched repository. Height is deviation from that repository's own fork baseline. ${marks.filter((m) => m.state === 'confirmed').length} confirmed above baseline.">
    <line class="baseline-rule" x1="0" y1="${baselineY}" x2="100" y2="${baselineY}"></line>
    ${bars}
  </svg>
  <figcaption class="strip-scale">
    <span class="label">${marks.length} repositories, first to last by name</span>
    <span class="label">${
      forming
        ? 'All baselines still forming — outlines, not readings'
        : "Dashed line = this repository's normal"
    }</span>
  </figcaption>
  <div class="strip-legend">
    <span class="state state-confirmed">Confirmed spike</span>
    <span class="state state-detected">Detected once</span>
    <span class="state state-forming">Baseline forming</span>
  </div>
</figure>`;
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
 * A named band.
 *
 * The page was a stack of sections separated by hairlines, and nothing told a
 * reader where one reading stopped and the next began. Hanging the name in a
 * fixed left rail is how a panel is labelled: the eye finds the same column
 * every time and no section carries a heading inline.
 *
 * The names were numbered 01–08 for a day. The brief bans sequential numbering
 * on things that are not a sequence, and the sections are ordered but not
 * enumerable — nobody refers to "reading 04". The rail does the work the
 * numbers were added for.
 */
export function band(name: string, inner: string, note?: string): string {
  if (inner.trim() === '') return '';

  return `<section class="band">
  <div class="band-rail">
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
  <aside class="install">
    <span class="install-label">Install for your coding agent</span>
    <code class="install-code" id="install-code">{ "mcpServers": { "sighttrue": { "url": "${SITE_ORIGIN}/api/mcp" } } }</code>
    <button type="button" class="install-copy" data-copy="install-code">Copy</button>
    <span class="install-note">Read-only. No key, no account.</span>
  </aside>
  <h1 class="hero-thesis">An instrument pointed at <em>${watchlist.active} open-source repositories</em>.</h1>
  <p class="hero-sub">
    Read every ${disclosure.cadenceHours} hours. Compared against its own history, never against
    anything else. Every figure links to its source.
  </p>
  ${
    index.adoption.weekly === 0
      ? ''
      : `<div class="hero-headline">
    <span class="hero-headline-value num" data-count="${index.adoption.weekly}">${index.adoption.weekly.toLocaleString('en')}</span>
    <span class="hero-headline-label">weekly downloads across the ${index.adoption.weeklyPackages}
    npm and PyPI packages these repositories publish. Measured, not estimated — and the only figure
    here that is a number today rather than in two weeks.</span>
  </div>`
  }
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
  <div class="hero-doors">
    <a class="door" href="/stack">
      <span class="door-name">Check your stack</span>
      <span class="door-note">Paste a manifest. Nothing leaves the browser.</span>
    </a>
    <a class="door" href="/compare">
      <span class="door-name">Compare two projects</span>
      <span class="door-note">Every axis at once.</span>
    </a>
    <a class="door" href="/method#agents">
      <span class="door-name">Wire it to your agent</span>
      <span class="door-note">MCP endpoint. Read-only, no key.</span>
    </a>
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
<p class="basis label">Forks added covers measured repositories only. No figure means not
yet measured, never zero.</p>`;
}

const REGISTRY_LABEL: Record<string, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  crates: 'crates.io',
  brew: 'Homebrew',
};

const WINDOW_LABEL: Record<string, string> = {
  week: 'per week',
  '30d': 'per 30 days',
  '90d': 'per 90 days',
};

/**
 * What is actually being installed.
 *
 * The only reading here that is a number today rather than in fourteen days,
 * and for a long time it was collected and shown to nobody. It is also the only
 * place this page has real scale in it — a fork count is in the hundreds, a
 * weekly download count is in the hundreds of millions — so the figures are set
 * large. That is not decoration; it is the one honest opportunity the page has
 * to look like something is happening, because something is.
 */
function adoptionHtml(index: IndexBundle): string {
  const { adoption } = index;
  if (adoption.top.length === 0) return '';

  // Magnitude on a shared scale, so the table reads as a chart rather than as a
  // column of digits nobody compares. Bars are drawn against the largest
  // reading and the scale is stated in the caption — a bar with no stated
  // maximum is a shape, not a measurement.
  const peak = Math.max(...adoption.top.map((reading) => reading.count));

  const rows = adoption.top
    .map((reading, rank) => {
      const share = peak === 0 ? 0 : reading.count / peak;
      // Five steps of one hue. Ordered by lightness, so the step carries the
      // same information the length does and neither depends on hue vision.
      const step = Math.min(5, Math.max(1, Math.ceil(share * 5)));

      return `<tr>
      <td class="n dim num">${rank + 1}</td>
      <td>${repoLink(reading.repo)}</td>
      <td class="dim">${esc(REGISTRY_LABEL[reading.registry] ?? reading.registry)} <span class="dim">${esc(reading.name)}</span></td>
      <td class="n"><span class="big num">${reading.count.toLocaleString('en')}</span></td>
      <td class="mag-cell">
        <span class="mag" style="--share:${(share * 100).toFixed(1)}%;--step:var(--mag-${step});--i:${rank}"></span>
      </td>
      <td class="dim">${esc(WINDOW_LABEL[reading.window] ?? reading.window)}</td>
    </tr>`;
    })
    .join('');

  return `<div class="wrap"><table class="readout readout-adoption">
  <caption class="label">Installs — ${adoption.measured} packages read${adoption.unread === 0 ? '' : `, ${adoption.unread} not readable this run`}</caption>
  <thead><tr>
    <th scope="col" class="n">#</th>
    <th scope="col">Repository</th>
    <th scope="col">Package</th>
    <th scope="col" class="n">Downloads</th>
    <th scope="col">Against the largest</th>
    <th scope="col">Window</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="basis label">Bars against ${peak.toLocaleString('en')}. Windows never added together.
<a href="/method">How</a></p>`;
}

/**
 * Where attention and use disagree.
 *
 * The one reading here that no single source could produce. Stars come from
 * GitHub, installs from a registry, and the disagreement between them exists
 * only because both are on the same page — which is the entire reason this
 * project is not a GitHub summariser.
 *
 * It states a disagreement. It does not say which number is the right one to
 * care about, and it never calls either side a winner.
 */
function divergenceHtml(index: IndexBundle): string {
  const { divergence } = index;
  if (divergence.compared === 0) return '';

  const row = (reading: (typeof divergence.used)[number]): string => `<tr>
      <td>${repoLink(reading.repo)}</td>
      <td class="n num">${reading.stars.toLocaleString('en')}</td>
      <td class="n"><span class="big num">${reading.installs.toLocaleString('en')}</span></td>
      <td class="n num">${reading.perStar >= 100 ? Math.round(reading.perStar).toLocaleString('en') : reading.perStar.toFixed(1)}</td>
    </tr>`;

  const table = (
    caption: string,
    rows: readonly (typeof divergence.used)[number][],
  ): string => `<div class="wrap"><table class="readout">
  <caption class="label">${caption}</caption>
  <thead><tr>
    <th scope="col">Repository</th>
    <th scope="col" class="n">Stars</th>
    <th scope="col" class="n">Installs, weekly</th>
    <th scope="col" class="n">Per star</th>
  </tr></thead>
  <tbody>${rows.map(row).join('')}</tbody>
</table></div>`;

  return `${table('Used far more than watched', divergence.used)}
${table('Watched far more than used, through this registry', divergence.watched)}
<p class="basis label">Stars measure attention, installs measure use, and they are different
questions. Median across the ${divergence.compared} repositories where both figures are available:
${divergence.median === null ? '—' : divergence.median.toLocaleString('en')} installs per star.
A project distributed mainly as a binary will sit low here and that is a fact about the channel, not
about the project — repositories under ${MIN_INSTALLS.toLocaleString('en')} weekly installs are
excluded for exactly that reason. <a href="/method">How</a></p>`;
}

/**
 * What other people's analysis says about the watchlist.
 *
 * The first reading here that is not GitHub's numbers or a registry's counts.
 * It is also the one that has to be handled most carefully: a low score is a
 * claim about somebody else's engineering practices, so it is cited to the
 * body that made it, dated, and never computed here.
 *
 * Only scanned projects appear. A repository OpenSSF has never looked at has no
 * score, and sorting it to the bottom of a list ordered by score would publish
 * "worst practices" about a project nobody assessed.
 */
function healthHtml(index: IndexBundle): string {
  const { health } = index;
  if (health.scored === 0) return '';

  const rows = health.weakest
    .map(
      (reading) => `<tr>
      <td>${repoLink(reading.repo)}</td>
      <td class="n"><span class="score num">${(reading.scorecard as number).toFixed(1)}</span></td>
      <td class="n num">${reading.advisories === null ? '<span class="dim">—</span>' : reading.advisories}</td>
      <td class="dim">${reading.scoredAt === null ? '<span class="dim">—</span>' : esc(reading.scoredAt)}</td>
    </tr>`,
    )
    .join('');

  return `<div class="hero-figures health-figures">
  <div class="figure"><span class="figure-value num">${health.median === null ? '—' : health.median.toFixed(1)}</span><span class="label">Median scorecard, of 10</span></div>
  <div class="figure"><span class="figure-value num">${health.scored}</span><span class="label">Repositories scanned</span></div>
  <div class="figure"><span class="figure-value num">${health.unscored}</span><span class="label">Never scanned</span></div>
  <div class="figure"><span class="figure-value num">${health.advisories.toLocaleString('en')}</span><span class="label">Advisories on record</span></div>
</div>
<div class="wrap"><table class="readout">
  <caption class="label">Lowest scores among the ${health.scored} scanned</caption>
  <thead><tr>
    <th scope="col">Repository</th>
    <th scope="col" class="n">Scorecard</th>
    <th scope="col" class="n">Advisories</th>
    <th scope="col">Scored</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="basis label">Scorecards OpenSSF, advisories OSV — neither judged here.
${health.unscored} never scanned, and absent rather than zero. <a href="/method">How</a></p>`;
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

  // Bounded, with the truncation stated. A single day retracting 207 findings
  // put 225 rows and 76KB into this table, and an unbounded table is a page
  // that gets slower the worse a day goes.
  const SHOWN_TODAY = 40;
  const rows = index.today
    .slice(0, SHOWN_TODAY)
    .map(
      (event) => `<tr>
      <td class="dim">${timeOf(event.detectedAt)}</td>
      <td>${
        // A model id and a `product/cycle` pair sit in this column too, and
        // neither has a repository page. Sent to the finding instead of to a
        // profile that would describe them as an unwatched repository.
        isRepositorySubject(event.kind)
          ? repoLink(event.repo)
          : `<a href="/e/${esc(eventSlug(event.id))}">${esc(event.repo)}</a>`
      }</td>
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
      <caption class="label">Today — ${index.today.length} signals${index.today.length > SHOWN_TODAY ? `, newest ${SHOWN_TODAY} shown` : ''}</caption>
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
    title: 'Live — every reading, right now',
    current: '/live',
    path: '/live',
    index,
    meta,
    body: `${heroHtml(index, meta)}
${band('Attention vs use', divergenceHtml(index), 'Stars and installs answer different questions, and this is where they disagree. No single source can produce this reading.')}
${band('Installs', adoptionHtml(index), 'Stars can be bought. Installs cannot.')}
${band('Health', healthHtml(index), 'OpenSSF and OSV. Not judged here.')}
${band('Ask', askHtml(), 'Answered only from the readings here.')}
${band(
  'Watchlist',
  `${stripSvg(index.strip, releasedToday)}${coverageHtml(index)}${watchlistReadout(index.strip)}`,
  'Curated and partial. A category is why a repository was added, not a fact about it.',
)}
${band('Today', `${table}${formingNotice}`, 'Since midnight UTC. Empty is the ordinary state.')}
${band('Signals', lensesHtml(index), 'Five detectors. Most need fourteen days of history before they can say anything.')}
${band(
  'Our record',
  `${scorecardHtml(index)}${calibrationHtml(index)}`,
  'How often this has been right, and whether its bars are reachable.',
)}
${band('The token', tokenHtml(), 'What funds this.')}`,
  });
}

/**
 * How it works, what it cannot do, and who is paying for it.
 *
 * The project's stated credibility argument was "the commit log is public".
 * That is an argument aimed at an audience that does not exist: nobody reads a
 * stranger's commit log. Everything load-bearing about the method was only
 * legible to someone willing to read three hundred commits, which is to say it
 * was not legible.
 */
export function renderMethod(index: IndexBundle, meta: MetaRecord): string {
  const { disclosure, watchlist, coverage } = index;

  const crypto = coverage.find((row) => row.category === 'crypto-web3');
  const cryptoShare =
    crypto === undefined || watchlist.active === 0
      ? null
      : Math.round((crypto.repositories / watchlist.active) * 100);

  return layout({
    title: 'Method — Sighttrue',
    description:
      'How these readings are taken, what they cannot support, and who pays for the instrument.',
    current: '/method',
    path: '/method',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">How these readings are taken.</h1>
  <p class="hero-sub">
    Everything below is checkable. The agent that collects this data is a public repository, every
    figure on the site links to the source it came from, and the bundles behind every page are
    published at <a href="/data/index.json">/data/index.json</a>. This page exists because none of
    that is any use to a reader who would have to go looking for it.
  </p>
</section>

${band(
  'How a reading is taken',
  `<div class="prose method-prose">
  <p>
    Every ${disclosure.cadenceHours} hours the agent reads ${watchlist.active} repositories and
    writes down what it sees. Nothing is inferred from a single reading. A repository's fork count
    is compared against that repository's own trailing average — never against another
    repository's — and a comparison is only made once there are
    ${disclosure.minBaselineDays} days of history to compare with. Before then the count is shown
    raw and marked forming, which means not measured yet rather than measured at zero.
  </p>
  <p>
    A threshold crossed once is <em>detected</em>. It becomes <em>confirmed</em> only if it is still
    true on the next day's reading. That costs a day of speed and buys the thing that cannot be
    bought back: fork counts are trivially inflatable with throwaway accounts, and a single
    observation cannot tell a real surge from a manufactured one.
  </p>
  <p>
    Sentences that interpret a reading are written by a language model, and are set in this typeface
    with a dashed edge so they never look like the measurements around them. Before publication
    every number in such a sentence is checked against the record it describes; if the model
    produced a figure that is not there, the sentence is discarded and a templated one is used
    instead. A sentence that is certainly true beats a fluent one that might not be.
  </p>
</div>`,
)}

${band(
  'What this cannot tell you',
  `<div class="prose method-prose">
  <p>
    <strong>It is not a survey.</strong> The watchlist is ${watchlist.active} repositories chosen by
    hand. If something happens outside them, this instrument does not see it and has no way of
    knowing it missed it. No figure here supports a claim about open source as a whole, or about any
    field as a whole.
  </p>
  <p>
    <strong>It does not measure quality, popularity or momentum.</strong> It measures fork counts,
    release tags, issue text, dependency manifests and declared model ancestry. A repository
    appearing here is an observation, never an endorsement, and never a judgement that the project
    is good, bad, safe or unsafe.
  </p>
  <p>
    <strong>A finding is a co-occurrence, never a cause.</strong> That forks rose and a release
    followed is in the record. That one caused the other is not, and is never claimed.
  </p>
  <p>
    <strong>It is not real-time.</strong> Readings are ${disclosure.cadenceHours} hours apart at
    best, and a scheduled run can be delayed. The header always states when the last successful
    reading actually happened.
  </p>
</div>`,
)}

${band(
  'How you can tell if it is broken',
  `<div class="prose method-prose">
  <p>
    A detector set above anything that happens in the real world produces the same empty page as a
    quiet month, and looks equally healthy. So every observation is compared against its threshold
    whether or not it crosses, and the distribution is recorded the same day and published on the
    index under Our record.
  </p>
  <p>
    If a detector reads <em>never approached</em>, nothing has come within half its threshold across
    the whole window. That is not a statement about the repositories being watched. It is a
    statement that this instrument is set too high, and it is published because the alternative is
    asking readers to assume otherwise.
  </p>
  <p>
    The same section states how many confirmed fork findings were followed by a release from the
    same repository within ${index.scorecard.windowDays} days. That measures co-occurrence rather
    than accuracy, the sample is small, and it is published whatever it says.
  </p>
</div>`,
)}

${band(
  'Who pays, and what that buys',
  `<div class="prose method-prose">
  <p>
    This is funded by a token on Robinhood Chain. Trading it pays a fee, most of which goes to
    whoever launched the pool. Holding it grants nothing here, there is nothing to connect a wallet
    to, and no reading is behind it. It has not launched.
  </p>
  <p>
    <strong>The conflict worth stating.</strong>${
      cryptoShare === null
        ? ' Part of the watchlist is crypto and blockchain infrastructure, which is the same field the funding mechanism lives in.'
        : ` ${crypto?.repositories} of the ${watchlist.active} repositories watched — ${cryptoShare}% — are crypto and blockchain infrastructure, the same field this project's funding lives in.`
    }
    That share was chosen by hand and nothing measured it. It is disclosed here because a reader
    should not have to discover it themselves, and because it is exactly the kind of thing that
    costs a project its credibility when someone else finds it first.
  </p>
  <p>
    Corrections work the same way. Findings are append-only: a wrong one is superseded by a
    correction that appears in the same place with the same prominence, never deleted.
    ${
      index.lenses.demand.count === 0
        ? 'Every demand cluster published on the first live run was wrong and all of them were retracted that way.'
        : ''
    }
  </p>
</div>`,
)}

${band(
  'For coding agents',
  `<div class="prose method-prose" id="agents">
  <p>
    An MCP server over the same readings, so an agent answers "is this dependency healthy" from a
    measurement taken today rather than from training data a year old.
  </p>
  <pre class="method-code">{ "mcpServers": { "sighttrue": { "url": "${SITE_ORIGIN}/api/mcp" } } }</pre>
  <p>
    Six read-only tools: <code>check_package</code>, <code>check_stack</code>,
    <code>check_eol</code>, <code>compare_repositories</code>, <code>search_repositories</code>,
    <code>find_model</code>. No key, no account, no quota. Every result carries the limits above
    with it, because a scorecard pasted into a code review without them is a claim this project
    does not make.
  </p>
</div>`,
)}

${band(
  'Reading it without visiting',
  `<div class="prose method-prose">
  <p>
    Most days nothing crosses a threshold, which makes this a poor page to check daily and a
    reasonable one to subscribe to. The feed at <a href="/feed.xml">/feed.xml</a> carries confirmed
    findings only, and carries them at the same moment they appear here.
  </p>
  <p>
    If you would rather work with the data directly, every bundle behind every page is a static
    file: <a href="/data/index.json">/data/index.json</a> for the current state,
    <a href="/data/stack-index.json">/data/stack-index.json</a> keyed by package,
    <a href="/data/compare.json">/data/compare.json</a> one row per repository. No key, no rate
    limit, no account.
  </p>
  <p>
    <strong>For coding agents.</strong> The same readings are served over the Model Context
    Protocol at <code>/api/mcp</code>, with four read-only tools. An agent asked whether a
    dependency is healthy otherwise answers from training data a year old; this lets it answer from
    a reading taken today. Every result carries these limits with it, because a scorecard quoted
    into a code review without them is a claim this project does not make.
  </p>
</div>`,
)}`,
  });
}

/**
 * Two projects held against each other.
 *
 * The first thing here that is a tool rather than a reading, and the first
 * place the multi-axis data pays for itself: "more stars" is available from
 * GitHub, while "three times the installs, a lower scorecard and four times the
 * advisories" is not available anywhere, because nobody else joins these
 * sources.
 *
 * It compares and does not rank. Neither column is ever the winner, nothing is
 * totalled across axes — downloads and a score out of ten share no scale — and
 * a missing figure says so rather than being treated as a low one.
 */
export function renderCompare(index: IndexBundle, meta: MetaRecord): string {
  return layout({
    title: 'Compare — Sighttrue',
    description:
      'Hold two open-source projects against each other across downloads, security scorecard, advisories and repository activity.',
    current: '/compare',
    path: '/compare',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">Two projects, every axis at once.</h1>
  <p class="hero-sub">
    Downloads from npm and PyPI, the OpenSSF scorecard, advisories filed against what they publish,
    and what their repositories are doing — held side by side. Choosing between two libraries
    normally means opening five tabs and comparing numbers that were never measured the same way.
  </p>
</section>

${band(
  'Compare',
  `<p class="notice" id="cmp-loading">Loading ${index.watchlist.active} repositories…</p>
<div id="cmp" hidden>
  <div class="cmp-pickers">
    <label class="cmp-picker"><span class="label">First</span><select id="cmp-a"></select></label>
    <label class="cmp-picker"><span class="label">Second</span><select id="cmp-b"></select></label>
  </div>
  <div class="wrap"><table class="readout cmp-table">
    <thead><tr>
      <th scope="col">Measure</th>
      <th scope="col" class="n" id="cmp-head-a">—</th>
      <th scope="col" class="n" id="cmp-head-b">—</th>
    </tr></thead>
    <tbody id="cmp-body"></tbody>
  </table></div>
  <p class="basis label" id="cmp-note" hidden>Bars are drawn within each row against the larger of
  the two, never across rows: downloads and a score out of ten share no scale, and drawing them
  against one another would invent a comparison. Nothing here is totalled and neither column is a
  winner — a project with more downloads and more advisories is a project with more downloads and
  more advisories. Where a figure is missing the row says so; absence is not a low score.</p>
</div>
<noscript><p class="notice">This needs scripting. The same figures are in
<a href="/data/compare.json">the bundle it reads</a>.</p></noscript>`,
  'Pick two. The link updates as you choose, so a comparison is something you can send someone.',
)}`,
  });
}

/**
 * The instrument, pointed at the visitor's own project.
 *
 * Everything else here observes a list of 388 repositories chosen by a
 * stranger, and nobody wakes up wanting to know the fork velocity of somebody
 * else's watchlist. Every developer does have two hundred dependencies they
 * have never checked, because checking them by hand is tedious enough that
 * nobody does it.
 *
 * The watchlist stops being the product here and becomes the benchmark: "your
 * median is 5.2" is not a reading until it sits beside what the corpus medians.
 */
export function renderStack(index: IndexBundle, meta: MetaRecord): string {
  return layout({
    title: 'Your stack — Sighttrue',
    description:
      'Paste a manifest and get a readout of your own dependencies: what is archived, what relicensed, what carries advisories, and how the stack sits against a tracked corpus.',
    current: '/stack',
    path: '/stack',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">Point it at your own project.</h1>
  <p class="hero-sub">
    Paste a <code>package.json</code>, <code>requirements.txt</code> or <code>Cargo.toml</code>.
    Every dependency is checked for advisories. The ones tracked here also get a security
    scorecard, a licence and a last-push date.
  </p>
  <p class="hero-follow">
    <strong>Your manifest never leaves the browser.</strong> Package names go to
    <a href="https://osv.dev">OSV</a> for advisories; nothing else is sent anywhere.
  </p>
</section>

${band(
  'Your stack',
  `<form id="stack-form" class="stack-form">
    <textarea id="stack-input" rows="9" spellcheck="false"
      placeholder='{\n  "dependencies": {\n    "react": "^19.0.0",\n    "vite": "^6.0.0"\n  }\n}'></textarea>
    <button type="submit">Read it</button>
  </form>
  <div id="stack-out" hidden></div>
  <noscript><p class="notice">This runs entirely in the browser, so it needs scripting. The index it
  reads is at <a href="/data/stack-index.json">/data/stack-index.json</a>.</p></noscript>`,
  'Advisories are checked for every dependency. Scorecard and licence only for the ones tracked here.',
)}

${lifecycleHtml(index)}`,
  });
}

/**
 * The end-of-life clock.
 *
 * The dates are published years ahead and watched by almost nobody, which is
 * why a team learns Python 3.9 went unsupported when an auditor tells them. It
 * sits on this page because it is the same question the manifest box asks —
 * what am I running, and is it still getting fixes — one level below the
 * libraries.
 */
function lifecycleHtml(index: IndexBundle): string {
  const { lifecycle } = index;
  if (lifecycle.products === 0) return '';

  const soon =
    lifecycle.soon.length === 0
      ? `<p class="notice">Nothing tracked here loses support in the next year.</p>`
      : `<div class="wrap"><table class="readout">
  <caption class="label">Support ends within a year, soonest first</caption>
  <thead><tr>
    <th scope="col">Runtime</th>
    <th scope="col">Release</th>
    <th scope="col" class="n">Ends</th>
    <th scope="col" class="n">Days left</th>
    <th scope="col">Latest</th>
  </tr></thead>
  <tbody>${lifecycle.soon
    .map(
      (row) => `<tr>
      <td><a href="https://endoflife.date/${esc(row.product)}">${esc(row.product)}</a></td>
      <td class="num">${esc(row.cycle)}${row.lts ? ' <span class="label">LTS</span>' : ''}</td>
      <td class="n num">${esc(row.eol)}</td>
      <td class="n"><span class="big num">${row.days}</span></td>
      <td class="num">${row.latest === null ? '<span class="dim">—</span>' : esc(row.latest)}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`;

  // What to move to. Without this the table is a warning with no next step,
  // and the next step is the only part anybody acts on.
  const supported = lifecycle.supported
    .map(
      (row) => `<div class="metric">
      <span class="label">${esc(row.product)}</span>
      <span class="metric-value num">${esc(row.cycles.slice(0, 4).join(', '))}</span>
    </div>`,
    )
    .join('');

  return band(
    'End of life',
    `<div class="hero-figures">
    <div class="figure"><span class="figure-value num">${lifecycle.products}</span><span class="label">Runtimes tracked</span></div>
    <div class="figure"><span class="figure-value num">${lifecycle.approaching}</span><span class="label">Ending within a year</span></div>
    <div class="figure"><span class="figure-value num">${lifecycle.ended}</span><span class="label">Already unsupported</span></div>
  </div>
${soon}
  <div class="finding-metrics" style="padding-top:18px">${supported}</div>`,
    'Dates are published by endoflife.date and cited, never inferred. A release with no announced end date is not listed as ending.',
  );
}

/**
 * Who goes down, and how often.
 *
 * Every provider here publishes an incident feed and every one of those feeds
 * forgets after a few months. Ask how often a service went down last year and
 * the honest answer is that nobody kept the record — so the answer people use
 * is whatever they remember about the last bad week, which is a memory test
 * rather than a measurement.
 *
 * The comparison is the dangerous part and the caveat is put where the numbers
 * are, not in a footnote: a count measures how often a provider *announced*
 * something, and a company that posts every degradation will out-count one that
 * posts nothing.
 */
export function renderIncidents(index: IndexBundle, meta: MetaRecord): string {
  const { incidents } = index;

  const busiest = incidents.byProvider.filter((row) => row.count > 0);
  const quiet = incidents.byProvider.filter((row) => row.count === 0);

  const table =
    busiest.length === 0
      ? `<p class="notice">No incident has been announced by any of the ${incidents.providers}
      providers watched here in the last ${incidents.windowDays} days. That is what the feeds
      said, and it is a reading rather than a claim that nothing broke.</p>`
      : `<div class="wrap"><table class="readout">
  <caption class="label">Announced incidents, last ${incidents.windowDays} days</caption>
  <thead><tr>
    <th scope="col">Provider</th>
    <th scope="col" class="n">Incidents</th>
    <th scope="col" class="n">Marked resolved</th>
    <th scope="col">Most recent</th>
  </tr></thead>
  <tbody>${busiest
    .map(
      (row) => `<tr>
      <td>${esc(row.name)}</td>
      <td class="n"><span class="big num">${row.count}</span></td>
      <td class="n num">${row.resolved}</td>
      <td>${row.latestTitle === null ? '<span class="dim">—</span>' : esc(row.latestTitle)}
        ${row.latestAt === null ? '' : `<span class="label">${esc(row.latestAt.slice(0, 10))}</span>`}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`;

  const silent =
    quiet.length === 0
      ? ''
      : `<p class="band-note">Announced nothing in the window:
      ${quiet.map((row) => esc(row.name)).join(', ')}. Read that as published, not as proven.</p>`;

  const recent =
    incidents.recent.length === 0
      ? ''
      : `<div class="wrap"><table class="readout">
  <caption class="label">Newest first, across every provider</caption>
  <thead><tr>
    <th scope="col">Date</th>
    <th scope="col">Provider</th>
    <th scope="col">What they said it was</th>
  </tr></thead>
  <tbody>${incidents.recent
    .map(
      (row) => `<tr>
      <td class="dim num">${esc(row.at.slice(0, 10))}</td>
      <td>${esc(row.name)}</td>
      <td>${row.url === '' ? esc(row.title) : `<a href="${esc(row.url)}">${esc(row.title)}</a>`}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`;

  return layout({
    title: 'Status history — who goes down, and how often',
    description:
      'A dated record of announced incidents across twenty providers developers depend on, kept after their own status feeds stop carrying it.',
    current: '/incidents',
    path: '/incidents',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">Every status page forgets.</h1>
  <p class="hero-sub">
    Status feeds carry a few months and then drop the rest. Ask how often a provider went down
    last year and nobody has the record, so the answer people use is whatever they remember about
    the last bad week. These are their own announcements, kept.
  </p>
  <div class="hero-figures">
    <div class="figure"><span class="figure-value num">${incidents.providers}</span><span class="label">Providers watched</span></div>
    <div class="figure"><span class="figure-value num">${incidents.total}</span><span class="label">Incidents in ${incidents.windowDays} days</span></div>
    <div class="figure"><span class="figure-value num">${incidents.observedDays}</span><span class="label">Days on record here</span></div>
  </div>
</section>

${band(
  'By provider',
  `${table}
  ${silent}`,
  'A count is how often a provider announced something, not how often it broke. A company that publishes every degradation will out-count one that publishes nothing, so this ranks disclosure as much as reliability. Never read a low number as a good one.',
)}

${band('Recently', recent, 'Titles are the provider’s own wording, linking to their own write-up.')}

${hiringHtml(index)}`,
  });
}

/**
 * What employers are paying for.
 *
 * Every other reading in this product measures what developers publish. This
 * measures what somebody was willing to spend money to ask for, and the two
 * disagree often enough to be worth putting on one page — a framework can be
 * the most starred thing on GitHub and appear in four job posts.
 *
 * Shares rather than counts, because the threads are different sizes and
 * comparing raw numbers across them publishes a trend that is really a quieter
 * month. The sample is stated at the top of the band, not underneath it.
 */
function hiringHtml(index: IndexBundle): string {
  const { hiring } = index;
  if (hiring.month === null || hiring.sample === 0) return '';

  const flag = (reading: { conservative: boolean }): string =>
    reading.conservative
      ? ' <span class="label" title="Matched only in unmistakably technical context, so this is a floor rather than a count">floor</span>'
      : '';

  const move = (value: number | null): string => {
    if (value === null || value === 0) return '<span class="dim">—</span>';
    return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
  };

  const table = `<div class="wrap"><table class="readout">
  <caption class="label">Named in ${hiring.month}, most first</caption>
  <thead><tr>
    <th scope="col">Technology</th>
    <th scope="col" class="n">Posts</th>
    <th scope="col" class="n">Share</th>
    <th scope="col" class="n">Points vs ${hiring.previousMonth === null ? 'last month' : esc(hiring.previousMonth)}</th>
  </tr></thead>
  <tbody>${hiring.top
    .map(
      (reading) => `<tr>
      <td>${esc(reading.term)}${flag(reading)}</td>
      <td class="n num">${reading.posts}</td>
      <td class="n"><span class="big num">${reading.share.toFixed(1)}%</span></td>
      <td class="n num">${move(reading.move)}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`;

  const movers = (title: string, readings: typeof hiring.rising): string =>
    readings.length === 0
      ? ''
      : `<div class="finding-metrics">${readings
          .map(
            (reading) => `<div class="metric">
      <span class="label">${esc(reading.term)}</span>
      <span class="metric-value num">${move(reading.move)}</span>
    </div>`,
          )
          .join('')}</div>
    <p class="band-note">${esc(title)}</p>`;

  return band(
    'What employers asked for',
    `<div class="hero-figures">
    <div class="figure"><span class="figure-value num">${hiring.sample}</span><span class="label">Job posts in ${esc(hiring.month)}</span></div>
    <div class="figure"><span class="figure-value num">${hiring.previousSample}</span><span class="label">${hiring.previousMonth === null ? 'No prior month' : `Posts in ${esc(hiring.previousMonth)}`}</span></div>
    <div class="figure"><span class="figure-value num">${hiring.top.length}</span><span class="label">Technologies named</span></div>
  </div>
${table}
${movers('Asked for more often than last month', hiring.rising)}
${movers('Asked for less often than last month', hiring.falling)}`,
    `Counted from one Hacker News hiring thread a month — ${hiring.sample} posts, skewed hard toward American startups, and evidence about that population and no wider one. A post counts once however often it names a thing. Terms marked "floor" collide with ordinary English and are matched only in unmistakably technical context, so their number is a minimum rather than a count.`,
  );
}

/**
 * What models cost, and what stopped being offered.
 *
 * The first page here with nothing to do with a repository. It exists because
 * the prices move weekly across sixty providers and nobody keeps a dated
 * record — ask what a model cost three months ago and there is no honest
 * answer anywhere, which is how teams choose on a price they remember.
 */
export function renderModels(index: IndexBundle, meta: MetaRecord): string {
  const { models } = index;

  const price = (value: number): string =>
    value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;

  const table = (
    caption: string,
    rows: readonly (typeof models.cheapest)[number][],
  ): string =>
    rows.length === 0
      ? ''
      : `<div class="wrap"><table class="readout">
  <caption class="label">${caption}</caption>
  <thead><tr>
    <th scope="col">Model</th>
    <th scope="col" class="n">Per million in</th>
    <th scope="col" class="n">Context</th>
    <th scope="col" class="n">Moved</th>
  </tr></thead>
  <tbody>${rows
    .map(
      (row) => `<tr>
      <td>${esc(row.id)}</td>
      <td class="n"><span class="big num">${price(row.prompt)}</span></td>
      <td class="n num">${row.context === null ? '<span class="dim">—</span>' : row.context.toLocaleString('en')}</td>
      <td class="n num">${
        row.moved === null || row.moved === 0
          ? '<span class="dim">—</span>'
          : `${row.moved > 0 ? '+' : '−'}${price(Math.abs(row.moved)).slice(1)}`
      }</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`;

  return layout({
    title: 'Models — what they cost',
    description:
      'A dated record of what language models cost across sixty providers, what changed, and what quietly stopped being offered.',
    current: '/models',
    path: '/models',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">What a model costs today.</h1>
  <p class="hero-sub">
    Prices move weekly across ${models.providers} providers and nobody keeps a dated record. Ask
    what a model cost three months ago and there is no honest answer anywhere — which is how teams
    end up choosing on a price they remember.
  </p>
  <div class="hero-figures">
    <div class="figure"><span class="figure-value num">${models.available}</span><span class="label">Models offered</span></div>
    <div class="figure"><span class="figure-value num">${models.providers}</span><span class="label">Providers</span></div>
    <div class="figure"><span class="figure-value num">${models.moved.length}</span><span class="label">Prices moved</span></div>
    <div class="figure"><span class="figure-value num">${models.withdrawn}</span><span class="label">No longer offered</span></div>
  </div>
</section>

${band(
  'Cheapest per context',
  models.perContext.length === 0
    ? ''
    : `<div class="wrap"><table class="readout">
  <caption class="label">Price per million, per 100k of context window</caption>
  <thead><tr>
    <th scope="col">Model</th>
    <th scope="col" class="n">Per million in</th>
    <th scope="col" class="n">Context</th>
    <th scope="col" class="n">Per 100k context</th>
  </tr></thead>
  <tbody>${models.perContext
    .map(
      (row) => `<tr>
      <td>${esc(row.id)}</td>
      <td class="n num">${price(row.prompt)}</td>
      <td class="n num">${row.context === null ? '<span class="dim">—</span>' : row.context.toLocaleString('en')}</td>
      <td class="n"><span class="big num">$${(row.perContext as number).toFixed(4)}</span></td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`,
  'Everyone compares price per token as though the window were the same. Both axes span four orders of magnitude independently, and nobody publishes this one.',
)}
${band('Moved', table('Largest price change in the trend window', models.moved), 'Measured against the oldest reading held, not against yesterday — a price that drifted over three weeks moved.')}
${band('Cheapest', table('Lowest price per million prompt tokens', models.cheapest), 'Free tiers are excluded from both ends. Zero is a different offer, not a lower price.')}
${band('Dearest', table('Highest price per million prompt tokens', models.dearest), 'Four orders of magnitude separate the two ends of this catalogue.')}`,
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
