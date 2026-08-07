import { basisHtml, esc, eventSlug, layout, proseHtml, stateBadge } from './render.ts';
import { readingsOf, SIGNAL_LABEL } from './vocabulary.ts';
import type { IndexBundle } from '../types/bundles.ts';
import type { EventRecord } from '../types/events.ts';
import type { MetaRecord } from '../types/meta.ts';
import type { LiveStateRow } from '../types/state.ts';
import type { WatchlistEntry } from '../types/watchlist.ts';

/**
 * One repository, every signal, one axis.
 *
 * The lenses each answer a different question about the same object. This page
 * is where they meet: a release, a fork spike six hours later, and a cluster of
 * issues the next day are three separate facts that only become a story when
 * something puts them in order. Adjacency is the whole point, so elapsed time
 * between entries is rendered as a value rather than left for the reader to
 * subtract.
 */

export interface RepoSeriesPoint {
  date: string;
  forks: number;
  /** Forks added since the previous snapshot, spread across any gap. */
  added: number;
}

export interface RepoPageData {
  entry: WatchlistEntry;
  /**
   * False when the repository has recorded events but is no longer watched.
   *
   * Its page is still generated. The events happened and are permanent, they
   * link here, and a link that goes nowhere is worse than a page that explains
   * itself.
   */
  onWatchlist: boolean;
  state: LiveStateRow | null;
  /** Oldest first. */
  series: RepoSeriesPoint[];
  baselinePerDay: number | null;
  baselineDays: number;
  /**
   * The readings that are not GitHub's.
   *
   * These pages were 4.7KB of chrome around a fork count, and they are the
   * largest indexable surface this site has — 400 of them. Somebody searching
   * "is vitejs/vite maintained" is asking exactly what the scorecard, the
   * advisory count and the download trend answer, and all three were already
   * being collected and shown nowhere.
   */
  health: { scorecard: number | null; scoredAt: string | null; advisories: number | null } | null;
  /** Weekly downloads, largest across the packages this repository publishes. */
  installs: number | null;
  /** Newest first, capped so a long-lived page stays bounded. */
  events: EventRecord[];
  /** How many exist in total, so truncation is disclosed rather than silent. */
  totalEvents: number;
}

const MS_PER_HOUR = 3_600_000;

function reading(label: string, value: string, note = ''): string {
  return `<div class="metric">
    <span class="label">${esc(label)}</span>
    <span class="metric-value num">${esc(value)}</span>
    ${note === '' ? '' : `<span class="label">${esc(note)}</span>`}
  </div>`;
}

/**
 * Daily fork additions as bars, with the trailing mean drawn across them.
 *
 * Additions rather than totals: a cumulative line rises forever and hides the
 * thing being measured. The mean is drawn explicitly because every comparison
 * on this page is made against it, and a reference the reader cannot see is one
 * they cannot check. Y starts at zero, and it is not truncated.
 */
function sparkline(series: readonly RepoSeriesPoint[], baselinePerDay: number | null): string {
  if (series.length < 2) {
    return `<div class="notice">
      <strong>Baseline forming</strong>
      Fewer than two daily snapshots exist for this repository, so no rate can be computed yet.
      Counts below are raw readings.
    </div>`;
  }

  const W = 100;
  const H = 30;
  const peak = Math.max(1, ...series.map((point) => point.added));
  const step = W / series.length;
  const width = Math.max(step * 0.7, 0.2);

  const bars = series
    .map((point, i) => {
      const h = (point.added / peak) * H;
      return `<rect class="mark-quiet" x="${(i * step).toFixed(3)}" y="${(H - h).toFixed(2)}" width="${width.toFixed(3)}" height="${h.toFixed(2)}"><title>${esc(point.date)}: ${point.added} added</title></rect>`;
    })
    .join('');

  // A line over the bars that draws in reading order on load. The dash length
  // is the path length, so a longer series takes the same time to trace but
  // covers more ground — the motion is the shape of this repository's history,
  // not an effect applied to it.
  const points = series
    .map((point, i) => `${(i * step + width / 2).toFixed(2)},${(H - (point.added / peak) * H).toFixed(2)}`)
    .join(' ');
  const traceLength = Math.round(W * 1.3);

  const meanLine =
    baselinePerDay === null
      ? ''
      : `<line class="baseline-rule" x1="0" y1="${(H - (baselinePerDay / peak) * H).toFixed(2)}" x2="${W}" y2="${(H - (baselinePerDay / peak) * H).toFixed(2)}"></line>`;

  const first = series[0] as RepoSeriesPoint;
  const last = series[series.length - 1] as RepoSeriesPoint;

  return `<figure class="chart">
    <figcaption class="label">Forks added per day — ${series.length} daily samples, peak ${peak}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="Daily fork additions from ${esc(first.date)} to ${esc(last.date)}. Peak ${peak} in one day.${baselinePerDay === null ? '' : ` Trailing mean ${baselinePerDay.toFixed(1)} per day.`}">
      ${bars}
      <polyline class="trace" style="--len:${traceLength}" points="${points}" fill="none" stroke="var(--ink-700)" stroke-width="0.4" pathLength="${traceLength}"></polyline>
      ${meanLine}
    </svg>
    <div class="strip-scale">
      <span class="label">${esc(first.date)}</span>
      <span class="label">${baselinePerDay === null ? 'baseline forming' : `dashed = ${baselinePerDay.toFixed(1)}/day trailing mean`}</span>
      <span class="label">${esc(last.date)}</span>
    </div>
  </figure>`;
}

/** Human elapsed time between two adjacent entries. Encodes the adjacency. */
function gapLabel(newer: string, older: string): string {
  const hours = (Date.parse(newer) - Date.parse(older)) / MS_PER_HOUR;
  if (!Number.isFinite(hours) || hours < 0) return '';
  if (hours < 1) return `${Math.round(hours * 60)}m earlier`;
  if (hours < 48) return `${Math.round(hours)}h earlier`;
  return `${Math.round(hours / 24)}d earlier`;
}

function timelineEntry(event: EventRecord, previous: EventRecord | undefined): string {
  const gap = previous === undefined ? '' : gapLabel(previous.detectedAt, event.detectedAt);

  const metrics = readingsOf(event)
    .map(
      (reading) =>
        `<span class="tl-metric"><span class="label">${esc(reading.label)}</span> <span class="num">${esc(reading.value)}</span></span>`,
    )
    .join('');

  return `${gap === '' ? '' : `<li class="tl-gap"><span class="label">${esc(gap)}</span></li>`}
  <li class="tl-entry">
    <div class="tl-when">
      <a class="num" href="/e/${esc(eventSlug(event.id))}">${esc(event.detectedAt.slice(0, 10))}</a>
      <span class="num dim">${esc(event.detectedAt.slice(11, 16))} UTC</span>
    </div>
    <div class="tl-body">
      <div class="finding-head">
        <span class="label">${esc(SIGNAL_LABEL[event.kind])}</span>
        ${stateBadge(event.confidence)}
        <a class="label" href="${esc(event.evidenceUrl)}">Evidence</a>
      </div>
      ${basisHtml(event)}
      <div class="tl-metrics">${metrics}</div>
      ${proseHtml(event)}
    </div>
  </li>`;
}

export function renderRepoPage(
  data: RepoPageData,
  index: IndexBundle,
  meta: MetaRecord,
): string {
  const { entry, state, events } = data;

  const readings =
    state === null
      ? `<div class="notice"><strong>No reading yet</strong>
        This repository is on the watchlist but has not been collected. It will appear after the
        next pulse.</div>`
      : `<div class="finding-metrics">
        ${
          data.installs === null
            ? ''
            : reading('Downloads, weekly', data.installs.toLocaleString('en'))
        }
        ${
          data.health?.scorecard == null
            ? ''
            : reading('OpenSSF scorecard', `${data.health.scorecard.toFixed(1)} of 10`)
        }
        ${
          data.health?.advisories == null
            ? ''
            : reading('Advisories, all time', String(data.health.advisories))
        }
        ${reading('Licence', state.license ?? 'unidentified')}
        ${reading('Forks', String(state.forks))}
        ${reading('Stars', String(state.stars))}
        ${reading('Open issues', String(state.openIssues))}
        ${reading('Latest release', state.latestReleaseTag ?? 'none published')}
        ${reading('Last push', state.pushedAt === null ? 'unknown' : state.pushedAt.slice(0, 10))}
        ${reading('Baseline', data.baselinePerDay === null ? 'forming' : `${data.baselinePerDay.toFixed(1)}/day`, `${data.baselineDays} days of history`)}
      </div>`;

  const unwatched = data.onWatchlist
    ? ''
    : `<div class="notice"><strong>No longer watched</strong>
      This repository has been removed from the watchlist. Its recorded signals stay published
      because they were true when they were taken, but nothing new is being collected for it.</div>`;

  const inactive = state !== null && !state.active
    ? `<div class="notice notice-alert"><strong>No longer reachable</strong>
      The last check returned 404 — the repository was deleted, renamed, or made private. The
      readings below are the final ones collected.</div>`
    : '';

  // A repository with nothing recorded is the common case and must still read
  // as a working instrument, not a broken page.
  const timeline =
    events.length === 0
      ? `<div class="notice">
        <strong>No signals recorded</strong>
        Nothing has crossed the reporting bar for this repository since it was added on
        ${esc(entry.added)}. It is checked every ${index.disclosure.cadenceHours} hours along with
        the rest of the watchlist.
      </div>`
      : `<ol class="timeline">
        ${events.map((event, i) => timelineEntry(event, events[i - 1])).join('\n')}
      </ol>
      ${
        data.totalEvents > events.length
          ? `<div class="notice"><strong>Older signals not shown</strong>
            ${data.totalEvents - events.length} earlier ${data.totalEvents - events.length === 1 ? 'signal is' : 'signals are'}
            recorded for this repository but not rendered here. All of them remain in the published
            event ledger.</div>`
          : ''
      }`;

  const body = `
<section class="repo-head">
  <h1 class="repo-title">${esc(state?.fullName ?? entry.id)}</h1>
  <div class="repo-facts">
    <span class="label">${esc(entry.category)}</span>
    <span class="label">${data.onWatchlist ? `Watched since ${esc(entry.added)}` : 'Removed from the watchlist'}</span>
    ${
      state?.fullName != null && state.fullName.toLowerCase() !== entry.id.toLowerCase()
        ? `<span class="label">Watched as ${esc(entry.id)}</span>`
        : ''
    }
    <a class="label" href="https://github.com/${esc(entry.id)}">View on GitHub</a>
  </div>
</section>
${unwatched}
${inactive}
${readings}
${sparkline(data.series, data.baselinePerDay)}
<h2 class="label" style="padding:26px 0 2px">Timeline — ${data.totalEvents} recorded ${data.totalEvents === 1 ? 'signal' : 'signals'}, newest first</h2>
${timeline}`;

  return layout({
    title: `${entry.id} — Readout`,
    current: '',
    index,
    meta,
    // This repository's own feed, not the site's. Handing somebody four hundred
    // projects when they asked to follow one is how a feed link gets clicked
    // once and never again.
    feed: { href: `/repo/${entry.id}.xml`, title: `Readout — ${entry.id}` },
    body,
  });
}
