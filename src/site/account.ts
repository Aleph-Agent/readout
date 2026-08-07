import { band, esc, layout } from './render.ts';
import { LIMITS, REGISTRIES } from '../lib/watchlist-api.ts';
import type { IndexBundle } from '../types/bundles.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * Your stack, watched.
 *
 * The first page here that is about one person rather than the whole watchlist,
 * and it is built the same way as every other page: a static file on the CDN.
 * Two things arrive afterwards, and the split is the point.
 *
 * The names come from `/api/watchlist`, because only a server knows who is
 * asking. The readings come from `/data/stack-index.json` — the same file the
 * public stack page reads — because the site's rule is that no page depends on
 * a running server for what it asserts. The figures on your private page are
 * therefore the identical bytes anybody can download and check. A watchlist
 * page that computed its own numbers server-side would be the first page here
 * whose claims could not be verified from outside, and being checkable is the
 * product.
 *
 * Signed out, this is a sign-in prompt that states what it will ask GitHub for
 * before you click rather than after. That is the whole of the marketing on it.
 */
export function renderAccount(index: IndexBundle, meta: MetaRecord): string {
  const registryOptions = REGISTRIES.map(
    (registry) => `<option value="${esc(registry)}">${esc(registry)}</option>`,
  ).join('');

  const free = LIMITS['free'] ?? 10;

  return layout({
    title: 'Your stack — Sighttrue',
    description:
      'Watch your own dependencies with the same instrument. Sign in with GitHub — no scopes requested, no wallet, nothing to install.',
    current: '/account',
    path: '/account',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">Point it at your own stack.</h1>
  <p class="hero-sub">
    The public pages read ${index.watchlist.active} repositories chosen by hand. This reads yours.
    Name the packages you actually depend on and the same readings come back for those — advisories,
    maintenance score, licence, how long since anything really shipped.
  </p>
</section>

<div id="account-out">
${band(
  'Sign in with GitHub',
  `<p class="finding-detail" style="max-width:56ch">Nothing to install and nothing to connect.
    The first ${free} packages are free.</p>
  <p class="repo-facts"><a class="watch-signin" href="/api/auth/github/start?next=/account">Sign in with GitHub</a></p>
  <!-- Filled only when something went wrong, and it says what. Silence here was
       the original bug: a rejected cookie, a blocked request and a genuine
       first visit all drew the same page, so somebody who had just authorised
       on GitHub saw a sign-in button and no explanation. -->
  <p id="account-gate-note" class="watch-bad band-note" role="status" hidden></p>
  <ul class="watch-points">
    <li><b>No scopes are requested.</b> GitHub's authorisation screen will say it wants your public
      profile and nothing else. This cannot read your repositories, private or public, because it
      never asks for permission to.</li>
    <li><b>The access token is never stored.</b> It is used once, to read your username, and dropped
      when the request ends.</li>
    <li><b>No wallet connects to this site.</b> Not on this page, not on any page.</li>
  </ul>`,
  'What this asks GitHub for, stated before you click rather than after.',
)}
</div>

<div id="account-in" hidden>
${band(
  'Watching',
  `<form id="watch-form" class="stack-form watch-form">
    <div class="watch-row">
      <select id="watch-registry" name="registry" aria-label="Registry">${registryOptions}</select>
      <input id="watch-name" name="name" type="text" autocomplete="off" spellcheck="false"
             placeholder="react" aria-label="Package name" required />
      <button type="submit">Watch it</button>
    </div>
  </form>
  <p id="watch-message" class="band-note" role="status" aria-live="polite"></p>
  <div id="watch-rows"></div>
  <p class="repo-facts"><a class="label" href="/stack">Read a whole manifest at once</a>
    <button id="watch-signout" class="watch-signout" type="button">Sign out</button></p>`,
  'Readings come from /data/stack-index.json — the same published file the public pages use, so every figure here can be checked from outside.',
)}
</div>`,
  });
}
