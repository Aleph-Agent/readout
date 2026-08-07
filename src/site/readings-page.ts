import { band, esc, layout } from './render.ts';
import { READINGS } from './readings.ts';
import type { IndexBundle } from '../types/bundles.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * The channel list.
 *
 * One table, and the page the whole navigation rewrite exists for. A reader who
 * has never seen this site should finish this screen knowing everything it
 * measures, what each measurement answers, and how much of it there is right
 * now — without opening anything.
 *
 * The question column is doing the work. "Forks" is a noun and tells nobody
 * anything; "What is being copied faster than it usually is?" tells them
 * whether to click. The old navigation had the nouns and nothing else, which is
 * why fifteen of them read as noise.
 *
 * Every reading appears, including the ones sitting at zero. An instrument that
 * hides the channels currently carrying no signal is an instrument that lies
 * about its own coverage, and this site's whole argument is that its figures
 * can be checked — a quiet channel is a figure like any other.
 */
export function renderReadings(index: IndexBundle, meta: MetaRecord): string {
  const rows = READINGS.map((reading) => {
    const measure = reading.measure(index);

    return `<tr>
      <td><a href="${esc(reading.href)}">${esc(reading.label)}</a></td>
      <td class="reading-q">${esc(reading.question)}</td>
      <td class="n num">${measure === null ? '<span class="dim">—</span>' : measure.value.toLocaleString('en')}</td>
      <td class="dim">${measure === null ? '<span class="dim">—</span>' : esc(measure.unit)}</td>
    </tr>`;
  }).join('');

  return layout({
    title: 'Readings — Sighttrue',
    description:
      'Everything this instrument measures, and the question each reading answers. Releases, fork velocity, developer demand, dependency shifts, model lineage and prices, provider outages, registry health.',
    current: '/readings',
    path: '/readings',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">Eleven readings, taken every ${index.disclosure.cadenceHours} hours.</h1>
  <p class="hero-sub">
    Each one answers a question a repository page cannot. Counts are current as of the last run and
    come from the published bundles, so a reading sitting at zero says zero rather than disappearing.
  </p>
</section>

${band(
  'What it measures',
  `<div class="wrap"><table class="readout">
    <thead><tr>
      <th scope="col">Reading</th>
      <th scope="col">The question it answers</th>
      <th scope="col" class="n">Now</th>
      <th scope="col">Counting</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`,
  'A zero is a measurement. It means the detector ran and nothing crossed its threshold, not that the reading is missing — /method says what each threshold is.',
)}

${band(
  'Where the numbers come from',
  `<p class="finding-detail" style="max-width:58ch">
    ${index.watchlist.active} repositories chosen by hand, plus ${index.incidents.providers} status
    feeds, ${index.lifecycle.products} runtimes, ${index.adoption.measured} packages and
    ${index.contributors.measured} commit histories that have nothing to do with any watchlist.
  </p>
  <p class="repo-facts">
    <a class="label" href="/method">How each reading is taken, and what it cannot do</a>
    <a class="label" href="/data/index.json">The published bundle</a>
  </p>`,
  'The watchlist is curated and partial. Every page that counts from it says so.',
)}`,
  });
}
