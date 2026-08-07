import { band, esc, layout } from './render.ts';
import { eventDescription, eventPath } from './event.ts';
import { SIGNAL_LABEL } from './vocabulary.ts';
import type { BreakingSummary, CadenceSummary } from '../lib/releases-summary.ts';
import type { IndexBundle } from '../types/bundles.ts';
import { isRepositorySubject, type EventRecord } from '../types/events.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * The week, in one page.
 *
 * The homepage answers "what happened today" and every lens answers "what
 * happened in this one signal". Neither answers the question somebody who was
 * away actually has, which is what they missed — and a reader who checks a site
 * daily is a reader this project does not have.
 *
 * Nothing new is collected. Everything here is already in the ledger and was
 * only reachable by opening six pages and reading past the quiet days.
 */

export const DIGEST_DAYS = 7;

/** Rows per day before a busy day starts burying the ones after it. */
const PER_DAY = 12;

export interface WeekData {
  /** Every addressable finding in the window, newest first. */
  events: readonly EventRecord[];
  cadence: CadenceSummary;
  breaking: BreakingSummary;
  /** `YYYY-MM-DD` the window ends on. */
  today: string;
}

function dayName(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  return at.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

export function renderWeek(data: WeekData, index: IndexBundle, meta: MetaRecord): string {
  const byDay = new Map<string, EventRecord[]>();
  for (const event of data.events) {
    const day = event.detectedAt.slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(event);
    else byDay.set(day, [event]);
  }

  const days = [...byDay.keys()].sort().reverse();

  const timeline =
    days.length === 0
      ? `<p class="notice">Nothing crossed a threshold in the last ${DIGEST_DAYS} days. The
      watchlist was checked every four hours throughout; a quiet week is a reading, not a
      fault.</p>`
      : days
          .map((day) => {
            const found = byDay.get(day) as EventRecord[];
            const shown = found.slice(0, PER_DAY);

            return `<section class="digest-day">
  <h3 class="label">${esc(dayName(day))} — ${found.length} ${found.length === 1 ? 'finding' : 'findings'}${found.length > PER_DAY ? `, newest ${PER_DAY} shown` : ''}</h3>
  <div class="wrap"><table class="readout">
    <tbody>${shown
      .map(
        (event) => `<tr>
      <td class="dim">${esc(SIGNAL_LABEL[event.kind])}</td>
      <td>${
        isRepositorySubject(event.kind)
          ? `<a href="/repo/${esc(event.repo)}">${esc(event.repo)}</a>`
          : esc(event.repo)
      }</td>
      <td><a href="${esc(eventPath(event))}">${esc(eventDescription(event))}</a></td>
    </tr>`,
      )
      .join('')}</tbody>
  </table></div>
</section>`;
          })
          .join('');

  const late =
    data.cadence.overdue.length === 0
      ? `<p class="notice">Nothing on the watchlist is more than ${'2.5'}× past its own release
      rhythm. ${data.cadence.measured} ${data.cadence.measured === 1 ? 'repository has' : 'repositories have'}
      enough releases on record to be measured this way; ${data.cadence.forming} do not yet.</p>`
      : `<div class="wrap"><table class="readout">
  <caption class="label">Past their own usual gap between releases</caption>
  <thead><tr>
    <th scope="col">Repository</th>
    <th scope="col" class="n">Times its own rhythm</th>
    <th scope="col" class="n">Days since</th>
    <th scope="col" class="n">Its usual gap</th>
    <th scope="col">Last release</th>
  </tr></thead>
  <tbody>${data.cadence.overdue
    .map(
      (row) => `<tr>
      <td><a href="/repo/${esc(row.repo)}">${esc(row.repo)}</a></td>
      <td class="n"><span class="big num">${row.overdue}×</span></td>
      <td class="n num">${row.sinceLast}</td>
      <td class="n num">${row.medianGap} days</td>
      <td class="num">${row.lastTag === null ? '<span class="dim">—</span>' : esc(row.lastTag)}
        <span class="label">${esc(row.lastAt)}</span></td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`;

  const breaking =
    data.breaking.bumps.length === 0
      ? `<p class="notice">No major version crossed on record. ${data.breaking.compared}
      ${data.breaking.compared === 1 ? 'release has' : 'releases have'} both a version and a
      previous one to compare against.</p>`
      : `<div class="wrap"><table class="readout">
  <caption class="label">Major version crossed, newest first</caption>
  <thead><tr>
    <th scope="col">Repository</th>
    <th scope="col">From</th>
    <th scope="col">To</th>
    <th scope="col" class="n">Date</th>
  </tr></thead>
  <tbody>${data.breaking.bumps
    .map(
      (row) => `<tr>
      <td><a href="/repo/${esc(row.repo)}">${esc(row.repo)}</a></td>
      <td class="num dim">${esc(row.from)}</td>
      <td class="num"><a href="${esc(row.url)}">${esc(row.to)}</a></td>
      <td class="n num">${esc(row.at)}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`;

  return layout({
    title: 'This week — what you missed',
    description: `Every finding across every signal in the last ${DIGEST_DAYS} days, what stopped releasing, and what crossed a major version.`,
    current: '/week',
    path: '/week',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">What you missed.</h1>
  <p class="hero-sub">
    Every finding across every signal in the last ${DIGEST_DAYS} days, in one place. Most days
    nothing crosses a threshold, which makes this a poor page to check daily and the right one to
    check on a Monday.
  </p>
  <div class="hero-figures">
    <div class="figure"><span class="figure-value num">${data.events.length}</span><span class="label">Findings in ${DIGEST_DAYS} days</span></div>
    <div class="figure"><span class="figure-value num">${days.length}</span><span class="label">Days with anything at all</span></div>
    <div class="figure"><span class="figure-value num">${data.cadence.overdue.length}</span><span class="label">Overdue a release</span></div>
  </div>
</section>

${band('Day by day', timeline, `Newest first. Every finding links to its own page and to the evidence behind it.`)}

${band(
  'Stopped releasing',
  late,
  'Measured against each repository’s own median gap between releases, not against a fixed period — a project that ships weekly and a project that ships twice a year are both on time when they keep to their own rhythm. Under four releases on record there is no rhythm to be late against, and those are counted as forming rather than guessed at.',
)}

${band(
  'Crossed a major version',
  breaking,
  'Read from the version tag against the previous one. Calendar versions are excluded — a project on 2026.08 bumps its leading number every January, and reporting that as a breaking change would fill this page with nothing every new year. A major bump is a signal to read the changelog, not a claim that anything of yours broke.',
)}`,
  });
}
