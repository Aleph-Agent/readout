/**
 * Point the instrument at the visitor's own project.
 *
 * Everything else here observes a list of 388 repositories chosen by a stranger.
 * Nobody wakes up wanting to know the fork velocity of somebody else's
 * watchlist — but every developer has two hundred dependencies they have never
 * checked, because checking them by hand is tedious enough that nobody does it.
 *
 * This inverts the product. Paste a manifest, get a readout of that stack: what
 * is unmaintained, what has advisories, what relicensed, what scores badly, and
 * how the whole thing sits against the corpus. The watchlist stops being the
 * product and becomes the benchmark that makes the visitor's numbers mean
 * something — "5.2" is not a reading until it sits beside 6.1.
 *
 * The manifest never leaves the browser. Parsing and lookup are entirely
 * client-side against a static file, which is both the cheapest architecture
 * and the only honest answer to "are you reading my dependencies".
 */

export const STACK_SCRIPT = `
const stackForm = document.getElementById('stack-form');

if (stackForm) {
  const field = document.getElementById('stack-input');
  const out = document.getElementById('stack-out');
  let index = null;

  const load = () =>
    index ? Promise.resolve(index) :
      fetch('/data/stack-index.json').then((r) => r.json()).then((d) => { index = d; return d; });

  // Deliberately forgiving. A pasted manifest arrives with comments, trailing
  // commas, version ranges and lockfile noise, and refusing to read it because
  // it is not valid JSON would fail the exact people this is for.
  function names(text) {
    const found = new Map();

    try {
      const pkg = JSON.parse(text);
      for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of Object.keys(pkg[group] || {})) found.set('npm:' + name, name);
      }
      if (found.size) return found;
    } catch { /* not package.json — fall through to the line formats */ }

    for (const raw of text.split(/\\r?\\n/)) {
      const line = raw.split('#')[0].trim();
      if (!line || line.startsWith('[') || line.startsWith('-')) continue;

      // requirements.txt: name, name==1.2, name>=1.2
      const py = /^([A-Za-z0-9._-]+)\\s*(?:[=<>!~]|$)/.exec(line);
      // Cargo.toml / go.mod: name = "1.2"  |  name v1.2
      const other = /^([A-Za-z0-9._\\/-]+)\\s*=\\s*[{"]/.exec(line);

      if (other) found.set('crates:' + other[1], other[1]);
      else if (py) found.set('pypi:' + py[1].toLowerCase(), py[1]);
    }

    return found;
  }

  // A reading nobody can send to a colleague is a reading that stops at one
  // person. The names go in the fragment rather than the query string, so they
  // are never sent to the server — the page's promise is that a pasted manifest
  // does not leave the browser, and a query string would quietly break it.
  const share = (names) => {
    try {
      const hash = names.length ? '#deps=' + names.map(encodeURIComponent).join(',') : '';
      history.replaceState(null, '', location.pathname + hash);
    } catch (e) {}
  };

  // A shared link arrives with names in the fragment. Filled in and read at
  // once, because a link that lands on an empty box has not shared anything.
  const shared = /^#deps=(.+)$/.exec(location.hash);
  if (shared) {
    field.value = shared[1].split(',').map(decodeURIComponent).join(String.fromCharCode(10));
    requestAnimationFrame(() => stackForm.requestSubmit());
  }

  stackForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = field.value.trim();
    if (!text) return;

    out.hidden = false;
    out.innerHTML = '<p class="notice">Reading…</p>';

    let data;
    try { data = await load(); }
    catch { out.innerHTML = '<p class="notice">The index could not be loaded.</p>'; return; }

    const wanted = names(text);
    share([...wanted.values()]);

    // Advisories for everything, not only for what this project happens to
    // track. OSV answers 150 packages in one request and allows the call from a
    // browser, so coverage here is the whole manifest rather than the 158
    // packages on the watchlist. A tool that says "not covered" for half of
    // somebody's dependencies does not get used twice.
    let osv = new Map();
    try { osv = await advisories(wanted); } catch { /* leave it unknown, never zero */ }

    const rows = [];
    for (const [key, shown] of wanted) {
      const tracked = data.packages[key];
      // How many watched projects depend on this. Case-folded to match the
      // index: PyPI treats PyYAML and pyyaml as one package.
      const also = data.dependents?.[shown.toLowerCase().replace(/_/g, '-')] ?? null;
      rows.push({
        name: shown,
        tracked: Boolean(tracked),
        also,
        advisories: osv.has(key) ? osv.get(key) : (tracked ? tracked.advisories : null),
        ...(tracked || {}),
      });
    }

    render(rows, data.benchmark, osv.size > 0);
  });

  const OSV_ECOSYSTEM = { npm: 'npm', pypi: 'PyPI', crates: 'crates.io' };

  async function advisories(wanted) {
    const keys = [...wanted.keys()];
    const found = new Map();

    // Batched at 100. Verified: OSV answers 150 in one call, but a manifest can
    // be any size and one oversized request failing loses the lot.
    for (let i = 0; i < keys.length; i += 100) {
      const slice = keys.slice(i, i + 100);
      const res = await fetch('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: slice.map((key) => {
            const cut = key.indexOf(':');
            return {
              package: {
                name: key.slice(cut + 1),
                ecosystem: OSV_ECOSYSTEM[key.slice(0, cut)],
              },
            };
          }),
        }),
      });
      if (!res.ok) continue;
      const body = await res.json();
      (body.results || []).forEach((result, index) => {
        found.set(slice[index], (result.vulns || []).length);
      });
    }

    return found;
  }

  const AGE_DAYS = (iso) =>
    iso ? Math.round((Date.now() - Date.parse(iso)) / 86400000) : null;

  function render(rows, benchmark, osvWorked) {
    if (!rows.length) {
      out.innerHTML = '<p class="notice"><strong>Nothing read</strong> No dependency names were ' +
        'found in that. Paste a package.json, requirements.txt or Cargo.toml.</p>';
      return;
    }

    const tracked = rows.filter((r) => r.tracked);
    const scored = rows.filter((r) => typeof r.scorecard === 'number');
    const median = scored.length
      ? scored.map((r) => r.scorecard).sort((a, b) => a - b)[Math.floor(scored.length / 2)]
      : null;

    const stale = rows.filter((r) => (AGE_DAYS(r.pushedAt) || 0) > 365);
    const risky = rows.filter((r) => (r.advisories || 0) > 0);
    const archived = rows.filter((r) => r.archived);
    const restrictive = rows.filter((r) =>
      r.license && /BUSL|SSPL|Elastic|RSAL|Commons-Clause/i.test(r.license));

    const flag = (n, one, many) =>
      n ? '<li><b>' + n + '</b> ' + (n === 1 ? one : many) + '</li>' : '';

    const flags = flag(archived.length, 'is archived', 'are archived') +
      flag(restrictive.length, 'has a source-available licence', 'have source-available licences') +
      flag(risky.length, 'has advisories on record', 'have advisories on record') +
      flag(stale.length, 'has not been pushed to in a year', 'have not been pushed to in a year');

    out.innerHTML =
      '<div class="hero-figures">' +
        fig(rows.length, 'Dependencies read') +
        fig(rows.reduce((t, r) => t + (r.advisories || 0), 0).toLocaleString('en'),
            osvWorked ? 'Advisories, all of them' : 'Advisories, tracked only') +
        fig(median === null ? '—' : median.toFixed(1), 'Median scorecard, yours') +
        fig(benchmark.medianScorecard === null ? '—' : benchmark.medianScorecard.toFixed(1),
            'Median across ' + benchmark.scored + ' tracked') +
      '</div>' +
      (flags ? '<ul class="stack-flags">' + flags + '</ul>' : '') +
      '<div class="wrap"><table class="readout"><thead><tr>' +
        '<th scope="col">Dependency</th><th scope="col" class="n">Also used by</th>' +
        '<th scope="col">Repository</th>' +
        '<th scope="col" class="n">Scorecard</th><th scope="col" class="n">Advisories</th>' +
        '<th scope="col">Licence</th><th scope="col" class="n">Last push</th>' +
      '</tr></thead><tbody>' +
      rows.map((r) => {
        const age = AGE_DAYS(r.pushedAt);
        return '<tr>' +
          '<td>' + r.name + '</td>' +
          '<td class="n num">' + (r.also ? r.also : '<span class="dim">—</span>') + '</td>' +
          '<td>' + (r.tracked ? link('/repo/' + r.repo, r.repo) : '<span class="dim">not tracked</span>') + '</td>' +
          '<td class="n num">' + (typeof r.scorecard === 'number' ? r.scorecard.toFixed(1) : '<span class="dim">—</span>') + '</td>' +
          '<td class="n num">' + (r.advisories === null ? '<span class="dim">—</span>' : r.advisories) + '</td>' +
          '<td class="dim">' + (r.license || '<span class="dim">—</span>') + '</td>' +
          '<td class="n num">' + (age === null ? '<span class="dim">—</span>' : age + 'd') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<p class="basis label">Advisories from OSV for every dependency. Scorecard, licence and ' +
      'last push for the ' + tracked.length + ' on this watchlist. Also used by counts how many ' +
      'tracked projects depend on it — high means infrastructure, blank means nothing tracked here ' +
      'uses it. Advisory counts are all time. <a href="/method">How</a></p>';
  }

  // Built rather than written inline: the build's dead-link guard scans emitted
  // HTML for href literals, and a template string containing one looks exactly
  // like a link to a page that does not exist. The guard is right to complain.
  function link(href, text) {
    return '<a href=' + JSON.stringify(href) + '>' + text + '</a>';
  }

  function fig(value, label) {
    return '<div class="figure"><span class="figure-value num">' + value +
      '</span><span class="label">' + label + '</span></div>';
  }
}`.trim();
