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
 * years. A base image can weigh two hundred times its lightest sibling. A name
 * one keystroke from something you install every day can already be taken.
 */
export function renderEcosystem(index: IndexBundle, meta: MetaRecord): string {
  const { staleness, advisories, questions, images, names, contributors } = index;

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

  const weight =
    images.tags === 0
      ? ''
      : band(
          'What the first line of your Dockerfile costs',
          `<div class="hero-figures">
    <div class="figure"><span class="figure-value num">${images.tags}</span><span class="label">Tags read</span></div>
    <div class="figure"><span class="figure-value num">${images.images}</span><span class="label">Official images</span></div>
    <div class="figure"><span class="figure-value num">${images.stalestDays ?? '—'}</span><span class="label">Days since the stalest rebuild</span></div>
  </div>
  <div class="wrap"><table class="readout">
  <caption class="label">Heaviest tags, against the lightest tag of the same image</caption>
  <thead><tr>
    <th scope="col">Tag</th>
    <th scope="col" class="n">Size</th>
    <th scope="col" class="n">Over its lightest sibling</th>
    <th scope="col" class="n">Days since rebuild</th>
  </tr></thead>
  <tbody>${images.heaviest
    .map(
      (row) => `<tr>
      <td class="num">${esc(row.image)}:${esc(row.tag)}</td>
      <td class="n"><span class="big num">${Math.round(row.bytes / 1e6)} MB</span></td>
      <td class="n num">${row.overLightest === null ? '<span class="dim">lightest</span>' : `+${row.overLightest} MB`}</td>
      <td class="n num">${row.staleDays}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>
  <div class="wrap"><table class="readout">
  <caption class="label">Longest since the image behind the tag was rebuilt</caption>
  <thead><tr>
    <th scope="col">Tag</th>
    <th scope="col" class="n">Days since rebuild</th>
    <th scope="col" class="n">Size</th>
  </tr></thead>
  <tbody>${images.stalest
    .slice(0, 6)
    .map(
      (row) => `<tr>
      <td class="num">${esc(row.image)}:${esc(row.tag)}</td>
      <td class="n"><span class="big num">${row.staleDays}</span></td>
      <td class="n num">${Math.round(row.bytes / 1e6)} MB</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`,
          'A tag is a moving target — the image behind it today is not the one behind it last month. That is why the rebuild date is here: a tag nobody has rebuilt in months is shipping months of unpatched distribution packages, and it looks identical to one built this morning. Sizes are what Docker Hub reports for the compressed image.',
        );

  const nearMiss =
    names.found === 0
      ? ''
      : band(
          'Names one keystroke away',
          `<div class="hero-figures">
    <div class="figure"><span class="figure-value num">${names.found}</span><span class="label">Neighbouring names that exist</span></div>
    <div class="figure"><span class="figure-value num">${names.swept}</span><span class="label">Packages swept</span></div>
  </div>
  <div class="wrap"><table class="readout">
  <caption class="label">Real package, and the names on npm one edit from it</caption>
  <thead><tr>
    <th scope="col">Package</th>
    <th scope="col" class="n">Neighbours</th>
    <th scope="col">Names that exist</th>
  </tr></thead>
  <tbody>${names.byPackage
    .map(
      (row) => `<tr>
      <td class="num">${esc(row.canonical)}</td>
      <td class="n"><span class="big num">${row.neighbours.length}</span></td>
      <td class="num dim">${row.neighbours
        .slice(0, 8)
        .map((neighbour) => esc(neighbour.name))
        .join(', ')}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`,
          'These names exist on npm and are one edit from a package people install. That is the entire claim. None of them is being called malicious, and none should be read that way — near names are routinely forks, ports, translations, or somebody’s abandoned first attempt. Only deletions and transpositions are swept, so this finds fewer than exist and never claims to be a complete list.',
        );

  const concentrated =
    contributors.measured === 0
      ? ''
      : band(
          'How many people it would survive losing',
          `<div class="hero-figures">
    <div class="figure"><span class="figure-value num">${contributors.measured}</span><span class="label">Projects measured</span></div>
    <div class="figure"><span class="figure-value num">${contributors.singleAuthor}</span><span class="label">Where one person wrote half</span></div>
    <div class="figure"><span class="figure-value num">${contributors.medianBusFactor ?? '—'}</span><span class="label">Median bus factor</span></div>
  </div>
  <div class="wrap"><table class="readout">
  <caption class="label">Most concentrated commit history</caption>
  <thead><tr>
    <th scope="col">Repository</th>
    <th scope="col" class="n">Bus factor</th>
    <th scope="col" class="n">Largest share</th>
    <th scope="col" class="n">Contributors</th>
    <th scope="col" class="n">Commits counted</th>
  </tr></thead>
  <tbody>${contributors.concentrated
    .map(
      (row) => `<tr>
      <td><a href="/repo/${esc(row.repo)}">${esc(row.repo)}</a></td>
      <td class="n"><span class="big num">${row.busFactor}</span></td>
      <td class="n num">${row.topShare.toFixed(1)}%</td>
      <td class="n num">${row.contributors}${row.truncated ? '+' : ''}</td>
      <td class="n num">${row.commits.toLocaleString('en')}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`,
          'The bus factor is how many contributors, from the most prolific down, account for half the commits. One means half a project’s history came from a single person. Three things it is not: commit count is not contribution, and review, triage and documentation leave few commits while a project cannot run without them; it is history rather than the present, so a founder who left three years ago still dominates; and a low number is a fact about a distribution, never an accusation about anybody. A contributor count with a plus sign was capped at a hundred.',
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
  <h1 class="hero-thesis">Six things a repository cannot tell you.</h1>
  <p class="hero-sub">
    A project can have commits this week and a package nobody has shipped in two years. A base
    image can weigh two hundred times its lightest sibling. A name one keystroke from something
    you install every day can already be taken. Read from the package registries, Docker Hub,
    OSV and Stack Overflow.
  </p>
</section>

${shipped}
${weight}
${nearMiss}
${load}
${concentrated}
${asking}`,
  });
}
