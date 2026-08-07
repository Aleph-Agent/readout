import { band, esc, layout } from './render.ts';
import { findingsFrom } from './findings.ts';
import type { IndexBundle } from '../types/bundles.ts';
import type { MetaRecord } from '../types/meta.ts';

/** Shown, not linked — a reader copying an address needs to see it whole. */
const SITE_HOST = 'sighttrue.com';

/**
 * The front door.
 *
 * Until now typing the domain landed a first-time visitor on an MCP config
 * snippet, then a wall of figures. Both are the product working correctly and
 * neither answers the question somebody arriving actually has, which is what
 * this is and whether it is for them. A stranger who cannot answer that in ten
 * seconds leaves, and every reading behind the door might as well not exist.
 *
 * So the instrument moved to `/live` and this took its place. Exactly one URL
 * changed — the repository pages, the findings, the ecosystem readings all stay
 * where they were, so nothing that anybody has linked to breaks.
 *
 * It is still not a marketing page. It leads with a measured figure rather than
 * a promise, because the whole argument here is that the numbers can be checked
 * and a landing page that opens with adjectives contradicts it on the first
 * line.
 */
export function renderWelcome(index: IndexBundle, meta: MetaRecord): string {
  const lead = findingsFrom(index)[0];

  const { watchlist, disclosure, incidents, lifecycle, contributors, staleness, names } = index;

  /** Four things this measures that a repository page cannot tell you. */
  const answers: readonly { question: string; answer: string; href: string }[] = [
    {
      question: 'Has anybody actually shipped this?',
      answer:
        'Read from the registry, not from the last commit. A push is what a maintainer does for themselves; a release is what reaches you.',
      href: '/ecosystem',
    },
    {
      question: 'How many people would it survive losing?',
      answer:
        'Contributors accounting for half the commits. Every other health signal measures activity; none measures who is producing it.',
      href: '/ecosystem',
    },
    {
      question: 'When does it stop getting security fixes?',
      answer:
        'End-of-life dates are published years ahead and watched by almost nobody. A team learns its runtime went unsupported when an auditor tells them.',
      href: '/stack',
    },
    {
      question: 'Does the thing I depend on go down?',
      answer:
        'Provider incident history, kept after their own status pages drop it. Ask how often something failed last year and nobody has the record.',
      href: '/incidents',
    },
  ];

  const cards = answers
    .map(
      (entry) => `<div class="door">
      <h3 class="door-q">${esc(entry.question)}</h3>
      <p class="door-a">${esc(entry.answer)}</p>
      <a class="label" href="${esc(entry.href)}">See the readings</a>
    </div>`,
    )
    .join('');

  return layout({
    title: 'Sighttrue — take the reading, and check it',
    description:
      'An instrument pointed at open-source dependencies. What shipped, what stopped, who maintains it, when it stops getting fixes — measured every four hours and published so any figure can be checked.',
    current: '/',
    path: '/',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">Take the reading, and check it.</h1>
  <p class="hero-sub">
    Licences change. Runtimes go unsupported. Packages that look busy have not shipped in a year.
    This reads all of it every ${disclosure.cadenceHours} hours and publishes every figure as a
    file you can check.
  </p>

  <!-- The one link a visitor is most likely to want next, and it was buried in
       the bar at the size of a navigation label. Big, and in the space to the
       right of the sentence that was empty on every screen wider than a phone. -->
  <aside class="hero-follow-us">
    <span class="label">Follow the readings</span>
    <a class="hero-x" href="https://x.com/Sighttruehq" rel="me">@Sighttruehq</a>
    <span class="hero-x-note">One or two a day. Every post carries the figure it is making a claim about.</span>
  </aside>
</section>

${
  lead === undefined
    ? ''
    : band(
        'Something it found',
        `<p class="finding-detail" style="max-width:52ch">${esc(lead.headline)}.</p>
    <p class="finding-basis">${esc(lead.basis)}</p>
    <p class="repo-facts"><a class="label" href="/findings">Everything else it found</a></p>`,
        'Stated from the published data with the figures filled in, so it cannot drift from what was measured.',
      )
}

${band(
  'What it answers',
  `<div class="doors">${cards}</div>`,
  'Four questions a repository page cannot answer, because the answers are not on GitHub.',
)}

${band(
  'Ways in',
  `<div class="ways">
    <a class="way" href="/method#agents">
      <span class="way-kind">MCP server</span>
      <span class="way-what">Point your coding agent at it. Read-only, no key, no account.</span>
      <code class="way-addr">${SITE_HOST}/api/mcp</code>
    </a>
    <a class="way" href="/stack">
      <span class="way-kind">Your stack</span>
      <span class="way-what">Paste a manifest and read your own dependencies. Nothing installed.</span>
      <code class="way-addr">${SITE_HOST}/stack</code>
    </a>
    <a class="way" href="/data/index.json">
      <span class="way-kind">The files</span>
      <span class="way-what">Every reading, as published. This is what the pages are drawn from.</span>
      <code class="way-addr">${SITE_HOST}/data/index.json</code>
    </a>
    <a class="way" href="/feed.xml">
      <span class="way-kind">Feed</span>
      <span class="way-what">Findings as they are confirmed, in a reader rather than a timeline.</span>
      <code class="way-addr">${SITE_HOST}/feed.xml</code>
    </a>
  </div>`,
  'Four addresses rather than four words in a menu. A navigation label cannot say that the MCP endpoint needs no key, and that is the fact that decides whether somebody tries it.',
)}

${band(
  'What is behind it',
  `<div class="hero-figures">
    <div class="figure"><span class="figure-value num">${watchlist.active}</span><span class="label">Repositories</span></div>
    <div class="figure"><span class="figure-value num">${incidents.total.toLocaleString('en')}</span><span class="label">Incidents kept after the feeds dropped them</span></div>
    <div class="figure"><span class="figure-value num">${lifecycle.dated}</span><span class="label">Release lines on the end-of-life clock</span></div>
    <div class="figure"><span class="figure-value num">${contributors.measured}</span><span class="label">Commit histories, for the bus factor</span></div>
    <div class="figure"><span class="figure-value num">${staleness.measured}</span><span class="label">Packages, by real ship date</span></div>
    <div class="figure"><span class="figure-value num">${names.found}</span><span class="label">Names one keystroke from a real package</span></div>
  </div>
  <p class="band-note">The watchlist is curated and partial — chosen by hand, not a survey of open
  source. It says so on every page that counts from it.</p>
  <p class="repo-facts">
    <a class="label" href="/live">The instrument itself</a>
    <a class="label" href="/stack">Point it at your own stack</a>
    <a class="label" href="/method">How it works, and what it cannot do</a>
  </p>`,
)}`,
  });
}
