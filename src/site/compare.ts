/**
 * Two projects, side by side, across every axis this instrument reads.
 *
 * The first thing on this site that is a tool rather than a reading. It exists
 * because the multi-axis data only pays off when two things are held against
 * each other: "more stars" is a fact anybody can get from GitHub, while "three
 * times the installs, a lower scorecard, and four times the advisories" is a
 * comparison nobody publishes, because nobody else joins these sources.
 *
 * Entirely client-side over a static bundle. No endpoint, no query engine, and
 * the URL carries the pair so a comparison is a thing you can send someone.
 *
 * The hard rule it inherits: this compares, it does not rank. Neither column is
 * ever the winner, no total is computed across axes, and where one figure is
 * missing the row says so rather than treating absence as a low score.
 */

export const COMPARE_SCRIPT = `
const pick = (id) => document.getElementById(id);
const root = pick('cmp');

if (root) {
  const state = { rows: [], a: null, b: null };
  const fmt = new Intl.NumberFormat('en');

  const params = new URLSearchParams(location.search);

  fetch('/data/compare.json')
    .then((r) => r.json())
    .then((rows) => {
      state.rows = rows;
      for (const side of ['a', 'b']) {
        const list = pick('cmp-' + side);
        list.innerHTML = '<option value="">Choose a repository…</option>' +
          rows.map((r) => '<option value="' + r.id + '">' + r.name + '</option>').join('');
        const wanted = params.get(side);
        if (wanted && rows.some((r) => r.id === wanted)) list.value = wanted;
        list.addEventListener('change', () => { choose(side, list.value); });
        if (list.value) choose(side, list.value, true);
      }
      pick('cmp-loading').hidden = true;
      root.hidden = false;
      render();
    })
    .catch(() => {
      pick('cmp-loading').textContent = 'The comparison data could not be loaded.';
    });

  function choose(side, id, quiet) {
    state[side] = state.rows.find((r) => r.id === id) || null;
    if (!quiet) {
      const next = new URLSearchParams();
      if (state.a) next.set('a', state.a.id);
      if (state.b) next.set('b', state.b.id);
      history.replaceState(null, '', next.toString() ? '?' + next : location.pathname);
    }
    render();
  }

  // Every row states what it measures and over what window, because a number
  // beside another number with no unit is the easiest way to mislead here.
  const AXES = [
    { key: 'installs',   label: 'Downloads',  note: 'npm or PyPI, per week', fmt: (v) => fmt.format(v) },
    { key: 'scorecard',  label: 'Scorecard',  note: 'OpenSSF, of 10',        fmt: (v) => v.toFixed(1) },
    { key: 'advisories', label: 'Advisories', note: 'OSV, all time',         fmt: (v) => fmt.format(v) },
    { key: 'forks',      label: 'Forks',      note: 'GitHub, total',         fmt: (v) => fmt.format(v) },
    { key: 'stars',      label: 'Stars',      note: 'GitHub, total',         fmt: (v) => fmt.format(v) },
    { key: 'findings',   label: 'Findings',   note: 'recorded here',         fmt: (v) => fmt.format(v) },
  ];

  function render() {
    const { a, b } = state;
    pick('cmp-head-a').textContent = a ? a.name : '—';
    pick('cmp-head-b').textContent = b ? b.name : '—';

    if (!a || !b) {
      pick('cmp-body').innerHTML =
        '<tr><td colspan="4" class="dim">Choose two repositories to compare them.</td></tr>';
      pick('cmp-note').hidden = true;
      return;
    }

    pick('cmp-body').innerHTML = AXES.map((axis) => {
      const av = a[axis.key];
      const bv = b[axis.key];
      const has = typeof av === 'number' && typeof bv === 'number';

      // Bars are within the row only, against the larger of the two. Nothing is
      // scaled across axes: downloads and a score out of ten share no scale and
      // drawing them against one another would invent a comparison.
      const top = has ? Math.max(av, bv, 1) : 1;
      const bar = (v, side) =>
        typeof v !== 'number'
          ? '<span class="dim">not measured</span>'
          : '<span class="cmp-bar cmp-' + side + '" style="--share:' +
            ((v / top) * 100).toFixed(1) + '%"></span>';

      return '<tr>' +
        '<th scope="row">' + axis.label + '<span class="cmp-note">' + axis.note + '</span></th>' +
        '<td class="n"><span class="num">' +
          (typeof av === 'number' ? axis.fmt(av) : '<span class="dim">—</span>') +
        '</span>' + bar(av, 'a') + '</td>' +
        '<td class="n"><span class="num">' +
          (typeof bv === 'number' ? axis.fmt(bv) : '<span class="dim">—</span>') +
        '</span>' + bar(bv, 'b') + '</td>' +
      '</tr>';
    }).join('');

    pick('cmp-note').hidden = false;
  }
}`.trim();
