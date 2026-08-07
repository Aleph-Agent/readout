/**
 * Whether anybody is signed in, and what they are watching.
 *
 * Two blocks. The first fills the control in the chrome, on every page. The
 * second fills the watchlist, on the one page that has one. They share a single
 * request, because asking twice on the same page load is a request nobody
 * needed.
 *
 * The rule running through both: **never fail silently.** The first version of
 * this swallowed every error with an empty catch, so a blocked request, a
 * rejected cookie and a genuinely signed-out visitor all rendered the same
 * page — and somebody who had just authorised on GitHub was shown a sign-in
 * button with no explanation and no way to find out why. A page that cannot say
 * what went wrong is a page that makes its reader guess.
 */

/**
 * The chrome control.
 *
 * Sign-in used to be a link halfway down `/account`, which meant a reader had
 * to already know the feature existed to find the way in, and no page anywhere
 * said whether they were signed in. It belongs in the bar that is on every
 * page, next to the theme switch, where a reader looks for it.
 *
 * Filled by script because every page here is a static file: the markup cannot
 * know who is reading it, only the browser can ask.
 */
export const CHROME_ACCOUNT_SCRIPT = `
(function () {
  const slot = document.querySelector('[data-account-slot]');
  if (!slot) return;

  const here = location.pathname + location.search;
  const signInHref = '/api/auth/github/start?next=' + encodeURIComponent(here);

  // One request, shared. The watchlist block below waits on this same promise
  // rather than asking again.
  window.sighttrueMe = fetch('/api/auth/me', { credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new Error('the sign-in service answered ' + response.status);
      return response.json();
    });

  const text = (value) => {
    const node = document.createElement('span');
    node.textContent = String(value == null ? '' : value);
    return node.innerHTML;
  };

  window.sighttrueMe.then((me) => {
    if (me.account) {
      slot.innerHTML = '<a class="label" href="/account">' + text(me.account.login) + '</a>' +
        '<button class="chrome-signout" type="button">Sign out</button>';
      slot.querySelector('.chrome-signout').addEventListener('click', async () => {
        // POST, not a link. A GET that ends a session can be fired by an image
        // tag on any other site.
        try {
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (e) {}
        location.reload();
      });
      return;
    }

    slot.innerHTML = '<a class="label" href=' + JSON.stringify(signInHref) + '>Sign in</a>';
  }).catch((error) => {
    // Visible, and honest about which half is unavailable. The readings on this
    // page are static files and are unaffected, so the wording says so rather
    // than implying the whole site is broken.
    slot.innerHTML = '<span class="label chrome-account-bad" title=' +
      JSON.stringify(String(error.message || error)) + '>Sign-in unavailable</span>';
  });
})();`.trim();

/**
 * The watchlist itself.
 *
 * The names come from `/api/watchlist`, because only a server knows who is
 * asking. The readings come from `/data/stack-index.json`, a static file on the
 * CDN, because no page here depends on a running server for what it asserts.
 *
 * Everything user-supplied goes through `text()` before it reaches innerHTML.
 * The names came back from an endpoint that already validated them, which is
 * exactly the reasoning that produces the injection nobody sees coming — the
 * validator changes, and the page that trusted it is three files away.
 */
export const ACCOUNT_SCRIPT = `
const accountOut = document.getElementById('account-out');

if (accountOut) {
  const signedIn = document.getElementById('account-in');
  const form = document.getElementById('watch-form');
  const field = document.getElementById('watch-name');
  const registry = document.getElementById('watch-registry');
  const message = document.getElementById('watch-message');
  const rowsOut = document.getElementById('watch-rows');
  const gate = document.getElementById('account-gate-note');

  // The callback marks its redirect. Without it, "never signed in" and "signed
  // in a second ago and the cookie did not survive" render the same page, and
  // the second one is the case where somebody needs telling something.
  const params = new URLSearchParams(location.search);
  const justSignedIn = params.has('signedin');
  if (justSignedIn) {
    params.delete('signedin');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
  }

  const text = (value) => {
    const node = document.createElement('span');
    node.textContent = String(value == null ? '' : value);
    return node.innerHTML;
  };

  const say = (words, bad) => {
    message.textContent = words || '';
    message.className = bad ? 'band-note watch-bad' : 'band-note';
  };

  let stack = null;
  const readings = () =>
    stack ? Promise.resolve(stack) :
      fetch('/data/stack-index.json').then((r) => r.json()).then((d) => { stack = d; return d; });

  // Signed out is a 200 with a null account, not a 401. An anonymous visitor is
  // a normal state of this site, and a page that has to catch an error to draw
  // its signed-out half will eventually draw it wrong.
  (window.sighttrueMe || Promise.reject(new Error('the sign-in check did not run')))
    .then((me) => {
      if (me.account) { accountOut.hidden = true; signedIn.hidden = false; return load(); }
      if (justSignedIn) {
        // GitHub said yes and the session did not survive the trip back. Almost
        // always a browser or extension refusing the cookie, so the message
        // names that rather than apologising for an unspecified problem.
        gate.hidden = false;
        gate.textContent = 'GitHub authorised the sign-in, but this browser did not keep the ' +
          'session cookie, so the site cannot tell who you are. It is a first-party cookie named ' +
          'st_session on this domain — a privacy extension or a blocked-cookies setting is the ' +
          'usual cause. Allowing cookies for sighttrue.com and signing in again should fix it.';
      }
    })
    .catch((error) => {
      gate.hidden = false;
      gate.textContent = 'Sign-in could not be checked: ' + (error.message || error) +
        '. The readings on this site are static files and are unaffected.';
    });

  async function load() {
    let mine;
    try {
      const response = await fetch('/api/watchlist', { credentials: 'same-origin' });
      if (response.status === 401) { location.reload(); return; }
      if (!response.ok) throw new Error('the watchlist service answered ' + response.status);
      mine = await response.json();
    } catch (error) {
      say((error.message || error) + '. Reload to try again.', true);
      return;
    }

    let data = { packages: {}, dependents: {}, benchmark: {} };
    // A failed index means the names still render with their readings blank.
    // Hiding somebody's own watchlist because a second file did not load is a
    // worse answer than showing it with dashes.
    let readingsFailed = false;
    try { data = await readings(); } catch { readingsFailed = true; }

    render(mine, data, readingsFailed);
  }

  const AGE_DAYS = (iso) => iso ? Math.round((Date.now() - Date.parse(iso)) / 86400000) : null;
  const dim = '<span class="dim">—</span>';

  function render(mine, data, readingsFailed) {
    const room = mine.items.length + ' of ' + mine.limit + ' on the ' + mine.plan + ' plan';
    say(readingsFailed ? room + '. The readings file could not be loaded, so the columns are blank.'
                       : room + '.', readingsFailed);

    if (!mine.items.length) {
      rowsOut.innerHTML = '<p class="notice"><strong>Nothing watched yet</strong> ' +
        'Add a package above, or paste a whole manifest on the stack page.</p>';
      return;
    }

    const body = mine.items.map((item) => {
      const found = data.packages[item.registry + ':' + item.name] || null;
      const age = found ? AGE_DAYS(found.pushedAt) : null;
      const also = data.dependents
        ? data.dependents[item.name.toLowerCase().replace(/_/g, '-')]
        : null;

      return '<tr>' +
        '<td>' + text(item.name) + '</td>' +
        '<td class="dim">' + text(item.registry) + '</td>' +
        '<td>' + (found ? link('/repo/' + found.repo, text(found.repo)) : '<span class="dim">not tracked</span>') + '</td>' +
        '<td class="n num">' + (typeof found?.scorecard === 'number' ? found.scorecard.toFixed(1) : dim) + '</td>' +
        '<td class="n num">' + (found && found.advisories !== null ? found.advisories : dim) + '</td>' +
        '<td class="dim">' + (found && found.license ? text(found.license) : dim) + '</td>' +
        '<td class="n num">' + (age === null ? dim : age + 'd') + '</td>' +
        '<td class="n num">' + (also ? also : dim) + '</td>' +
        '<td><button class="watch-drop" type="button" data-registry="' + text(item.registry) +
          '" data-name="' + text(item.name) + '" aria-label="Stop watching ' + text(item.name) +
          '">Drop</button></td>' +
      '</tr>';
    }).join('');

    rowsOut.innerHTML = '<div class="wrap"><table class="readout"><thead><tr>' +
      '<th scope="col">Package</th><th scope="col">Registry</th><th scope="col">Repository</th>' +
      '<th scope="col" class="n">Scorecard</th><th scope="col" class="n">Advisories</th>' +
      '<th scope="col">Licence</th><th scope="col" class="n">Last push</th>' +
      '<th scope="col" class="n">Also used by</th><th scope="col"></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="basis label">Not tracked means this instrument has no reading for that package ' +
      'yet, not that nothing is wrong with it. Also used by counts how many watched projects ' +
      'depend on it. <a href="/method">How</a></p>';
  }

  // Built rather than written inline: the build's dead-link guard scans emitted
  // output for href literals, and one in a template string looks exactly like a
  // link to a page that does not exist.
  function link(href, label) {
    return '<a href=' + JSON.stringify(href) + '>' + label + '</a>';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = field.value.trim();
    if (!name) return;

    say('Adding…');
    try {
      const response = await fetch('/api/watchlist', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ registry: registry.value, name }),
      });
      const body = await response.json();
      // The endpoint's own words. It knows the limit and the plan; repeating
      // that here in different wording is two places to keep in step.
      if (!response.ok) { say(body.error || 'That could not be added.', true); return; }
      field.value = '';
      await load();
    } catch (error) { say('Could not reach the server: ' + (error.message || error), true); }
  });

  rowsOut.addEventListener('click', async (event) => {
    const button = event.target.closest('.watch-drop');
    if (!button) return;

    button.disabled = true;
    const query = '?registry=' + encodeURIComponent(button.dataset.registry) +
      '&name=' + encodeURIComponent(button.dataset.name);
    try {
      await fetch('/api/watchlist' + query, { method: 'DELETE', credentials: 'same-origin' });
      await load();
    } catch (error) { button.disabled = false; say('Could not remove that.', true); }
  });

  document.getElementById('watch-signout').addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
    location.reload();
  });
}`.trim();
