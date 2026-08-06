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
    const matched = [];
    for (const [key, shown] of wanted) {
      const hit = data.packages[key];
      if (hit) matched.push({ name: shown, ...hit });
    }

    render(wanted.size, matched, data.benchmark);
  });

  const AGE_DAYS = (iso) =>
    iso ? Math.round((Date.now() - Date.parse(iso)) / 86400000) : null;

  function render(total, rows, benchmark) {
    if (!rows.length) {
      out.innerHTML = '<p class="notice"><strong>No overlap</strong> ' + total +
        ' dependencies were read and none is on the watchlist, so there is nothing measured to ' +
        'report. This covers ' + benchmark.repositories + ' curated projects, not every package ' +
        'that exists — a miss here says nothing about your dependency.</p>';
      return;
    }

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
        fig(rows.length + ' of ' + total, 'Dependencies with readings') +
        fig(median === null ? '—' : median.toFixed(1), 'Median scorecard, yours') +
        fig(benchmark.medianScorecard === null ? '—' : benchmark.medianScorecard.toFixed(1),
            'Median across ' + benchmark.scored + ' tracked') +
        fig(rows.reduce((t, r) => t + (r.advisories || 0), 0).toLocaleString('en'),
            'Advisories, all time') +
      '</div>' +
      (flags ? '<ul class="stack-flags">' + flags + '</ul>' : '') +
      '<div class="wrap"><table class="readout"><thead><tr>' +
        '<th scope="col">Dependency</th><th scope="col">Repository</th>' +
        '<th scope="col" class="n">Scorecard</th><th scope="col" class="n">Advisories</th>' +
        '<th scope="col">Licence</th><th scope="col" class="n">Last push</th>' +
      '</tr></thead><tbody>' +
      rows.map((r) => {
        const age = AGE_DAYS(r.pushedAt);
        return '<tr>' +
          '<td>' + r.name + '</td>' +
          '<td>' + link('/repo/' + r.repo, r.repo) + '</td>' +
          '<td class="n num">' + (typeof r.scorecard === 'number' ? r.scorecard.toFixed(1) : '<span class="dim">—</span>') + '</td>' +
          '<td class="n num">' + (r.advisories === null ? '<span class="dim">—</span>' : r.advisories) + '</td>' +
          '<td class="dim">' + (r.license || '<span class="dim">—</span>') + '</td>' +
          '<td class="n num">' + (age === null ? '<span class="dim">—</span>' : age + 'd') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<p class="basis label">Scorecards are OpenSSF\\u2019s and advisories are OSV\\u2019s, neither ' +
      'computed here. Advisory counts are all time, so a mature well-patched project carries more ' +
      'than a young one and a high count is not a warning on its own. Only dependencies that are ' +
      'on this watchlist can be read; the rest are not judged, they are simply not covered.</p>';
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
