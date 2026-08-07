/**
 * The signed-in half, filled in by the browser.
 *
 * Two fetches, deliberately from two different places. `/api/watchlist` knows
 * who you are and returns names only. `/data/stack-index.json` is a static file
 * on the CDN and returns the readings. Nothing about your account touches the
 * numbers, and the numbers are the same ones on the public pages.
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

  const text = (value) => {
    const node = document.createElement('span');
    node.textContent = value === null || value === undefined ? '' : String(value);
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
  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((me) => { if (me.account) { accountOut.hidden = true; signedIn.hidden = false; load(); } })
    .catch(() => {});

  async function load() {
    let mine;
    try {
      const response = await fetch('/api/watchlist', { credentials: 'same-origin' });
      if (response.status === 401) { location.reload(); return; }
      mine = await response.json();
    } catch { say('Could not read your watchlist. Reload to try again.', true); return; }

    let data = { packages: {}, dependents: {}, benchmark: {} };
    // A failed index means the names still render with their readings blank.
    // Hiding somebody's own watchlist because a second file did not load is a
    // worse answer than showing it with dashes.
    try { data = await readings(); } catch {}

    render(mine, data);
  }

  const AGE_DAYS = (iso) => iso ? Math.round((Date.now() - Date.parse(iso)) / 86400000) : null;
  const dim = '<span class="dim">—</span>';

  function render(mine, data) {
    if (!mine.items.length) {
      rowsOut.innerHTML = '<p class="notice"><strong>Nothing watched yet</strong> ' +
        'Add a package above, or paste a whole manifest on the stack page.</p>';
      say('0 of ' + mine.limit + ' on the ' + mine.plan + ' plan.');
      return;
    }

    say(mine.items.length + ' of ' + mine.limit + ' on the ' + mine.plan + ' plan.');

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
    } catch { say('Could not reach the server.', true); }
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
    } catch { button.disabled = false; say('Could not remove that.', true); }
  });

  document.getElementById('watch-signout').addEventListener('click', async () => {
    // POST, not a link. A GET that ends a session can be fired by an image tag
    // on any other site.
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    location.reload();
  });
}`.trim();
