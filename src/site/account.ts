import { band, esc } from './render.ts';
import { LIMITS, REGISTRIES } from '../lib/watchlist-api.ts';

/**
 * The saved watchlist, as two bands on the stack page.
 *
 * It was a page of its own at `/account`, and that was the confusion the
 * navigation rewrite exists to remove: two pages, both titled "Your stack", one
 * reached from the bar and one from the account name, doing halves of the same
 * job. A reader who pasted a manifest had no reason to think a second page
 * existed, and a reader who signed in found a watchlist with no way to fill it
 * from a file.
 *
 * One page now. Paste a manifest and get a reading, with no account and nothing
 * installed; sign in and the same page also keeps a list. The account is an
 * upgrade to a tool that already worked, which is the only honest order to put
 * them in.
 *
 * Both bands render on every visit and the browser decides which to show —
 * every page here is a static file, so the markup cannot know who is reading it.
 */
export function watchlistBands(): string {
  const registryOptions = REGISTRIES.map(
    (registry) => `<option value="${esc(registry)}">${esc(registry)}</option>`,
  ).join('');

  const free = LIMITS['free'] ?? 10;

  const saved = band(
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
  <div id="watch-rows"></div>`,
    'Kept between visits, and read again on every run. The figures come from /data/stack-index.json — the same published file the public pages use, so anything here can be checked from outside.',
  );

  const offer = band(
    'Keep a list',
    `<p class="finding-detail" style="max-width:56ch">
      Pasting a manifest works with no account and nothing installed. Signing in adds one thing:
      the list is remembered, so you do not paste it again. The first ${free} packages are free.
    </p>
    <p class="repo-facts"><a class="watch-signin" href="/api/auth/github/start?next=/stack">Sign in with GitHub</a></p>
    <ul class="watch-points">
      <li><b>No scopes are requested.</b> GitHub's authorisation screen will say it wants your public
        profile and nothing else. This cannot read your repositories, private or public, because it
        never asks for permission to.</li>
      <li><b>The access token is never stored.</b> It is used once, to read your username, and dropped
        when the request ends.</li>
      <li><b>No wallet connects to this site.</b> Not on this page, not on any page.</li>
    </ul>
    <!-- Filled only when something went wrong, and it says what. Silence here
         was the original bug: a rejected cookie, a blocked request and a genuine
         first visit all drew the same page, so somebody who had just authorised
         on GitHub saw a sign-in button and no explanation. -->
    <p id="account-gate-note" class="watch-bad band-note" role="status" hidden></p>`,
    'What this asks GitHub for, stated before you click rather than after.',
  );

  return `<div id="account-in" hidden>${saved}</div>

<div id="account-out">${offer}</div>`;
}
