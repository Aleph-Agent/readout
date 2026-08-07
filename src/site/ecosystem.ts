import { band, esc, layout } from './render.ts';
import type { IndexBundle } from '../types/bundles.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * The readings that never touch GitHub.
 *
 * The complaint this page answers is the fair one: everything else here is
 * GitHub, summarised. These come from the package registries, from OSV, and
 * from Stack Overflow, and each says something a repository cannot.
 *
 * A project can have commits this week and a package nobody has shipped in two
 * years. An ecosystem can carry five times the advisory load of its neighbour.
 * A tag can go a month with nobody asking anything about it.
 */
export function renderEcosystem(index: IndexBundle, meta: MetaRecord): string {
  const { staleness, advisories, questions } = index;

  const signed = (value: number, suffix = ''): string =>
    `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}${suffix}`;

  const shipped =
    staleness.measured === 0
      ? ''
      : band(
          'Last actually shipped',
          `<div class="hero-figures">
    <div class="figure"><span class="figure-value num">${staleness.measured}</span><span class="label">Packages read</span></div>
    <div class="figure"><span class="figure-value num">${staleness.medianDays ?? '—'}</span><span class="label">Median days since release</span></div>
    <div class="figure"><span class="figure-value num">${staleness.overAYear}</span><span class="label">Silent over a year</span></div>
  </div>
  <div class="wrap"><table class="readout">
  <caption class="label">Longest without a release</caption>
  <thead><tr>
    <th scope="col">Package</th>
    <th scope="col">Registry</th>
    <th scope="col" class="n">Days quiet</th>
    <th scope="col">Last version</th>
  </tr></thead>
  <tbody>${staleness.quietest
    .map(
      (row) => `<tr>
      <td><a href="/repo/${esc(row.repo)}">${esc(row.name)}</a></td>
      <td class="dim">${esc(row.registry)}</td>
      <td class="n"><span class="big num">${row.days}</span></td>
      <td class="num">${row.version === null ? '<span class="dim">—</span>' : esc(row.version)}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>
  <div class="finding-metrics" style="padding-top:18px">${staleness.byRegistry
    .map(
      (row) => `<div class="metric">
      <span class="label">${esc(row.registry)} median</span>
      <span class="metric-value num">${row.medianDays ?? '—'} days</span>
    </div>`,
    )
    .join('')}</div>`,
          'Read from the registries, not from git. Every "is this maintained" badge in circulation reads a repository’s last push — but a push is what a maintainer does for themselves, and a release is what reaches the projects depending on them. The two come apart constantly.',
        );

  const load =
    advisories.registries === 0
      ? ''
      : band(
          'Advisory load by ecosystem',
          `<div class="wrap"><table class="readout">
  <caption class="label">All-time advisories across the packages watched here</caption>
  <thead><tr>
    <th scope="col">Registry</th>
    <th scope="col" class="n">Advisories</th>
    <th scope="col" class="n">Packages affected</th>
    <th scope="col" class="n">Per affected package</th>
    <th scope="col">Most</th>
  </tr></thead>
  <tbody>${advisories.byRegistry
    .map(
      (row) => `<tr>
      <td>${esc(row.registry)}</td>
      <td class="n"><span class="big num">${row.advisories}</span></td>
      <td class="n num">${row.affected} of ${row.packages}</td>
      <td class="n num">${row.perAffected ?? '—'}</td>
      <td class="dim">${row.worst
        .slice(0, 3)
        .map((worst) => esc(worst.name))
        .join(', ')}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`,
          'Not a survey of any ecosystem. A few dozen hand-picked projects per registry, chosen for being prominent, which is exactly the population most likely to have advisories filed against it. Counts are all-time, so age and scrutiny raise them as readily as danger does. The registries are not the same size or the same age, and per-package is the only comparison worth making — even that one is soft.',
        );

  const asking =
    questions.tags === 0
      ? ''
      : band(
          'Is anybody still asking',
          `<div class="hero-figures">
    <div class="figure"><span class="figure-value num">${questions.total}</span><span class="label">Questions in ${questions.windowDays} days</span></div>
    <div class="figure"><span class="figure-value num">${questions.medianChange ?? '—'}%</span><span class="label">Median tag, against the ${questions.windowDays} days before</span></div>
    <div class="figure"><span class="figure-value num">${questions.tags}</span><span class="label">Tags read</span></div>
  </div>
  <div class="wrap"><table class="readout">
  <caption class="label">Most asked about, and how each sits against the median tag</caption>
  <thead><tr>
    <th scope="col">Tag</th>
    <th scope="col" class="n">Questions</th>
    <th scope="col" class="n">Change</th>
    <th scope="col" class="n">Points vs median</th>
  </tr></thead>
  <tbody>${questions.busiest
    .map(
      (row) => `<tr>
      <td>${esc(row.tag)}</td>
      <td class="n"><span class="big num">${row.recent}</span></td>
      <td class="n num">${row.change === null ? '<span class="dim">too few</span>' : signed(row.change, '%')}</td>
      <td class="n num">${row.vsMedian === null ? '<span class="dim">—</span>' : signed(row.vsMedian)}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`,
          `Volume has fallen across nearly every tag on Stack Overflow since assistants started answering these questions instead, so a tag falling is the baseline rather than the finding — the median tag here moved ${questions.medianChange ?? 0}%. What survives that is the last column: how a tag moved against the rest over the same window. Under 25 questions in the earlier window there is no percentage at all, because four to two is a fifty percent collapse and means nothing.`,
        );

  return layout({
    title: 'Ecosystem — readings that are not GitHub',
    description:
      'When packages last actually shipped, advisory load per registry, and whether anybody is still asking questions. None of it read from GitHub.',
    current: '/ecosystem',
    path: '/ecosystem',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">Three things a repository cannot tell you.</h1>
  <p class="hero-sub">
    A project can have commits this week and a package nobody has shipped in two years. An
    ecosystem can carry five times the advisory load of its neighbour. A tag can go a month with
    nobody asking about it. Read from the package registries, from OSV, and from Stack Overflow.
  </p>
</section>

${shipped}
${load}
${asking}`,
  });
}
