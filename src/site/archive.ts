import { esc, layout } from './render.ts';
import { eventDescription, eventPath } from './event.ts';
import type { IndexBundle, LensName } from '../types/bundles.ts';
import type { EventRecord } from '../types/events.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * Findings older than the lens window.
 *
 * The archive bundles were already being written and nothing linked to them, so
 * everything past 90 days was published and unreachable at the same time. A
 * ledger nobody can walk back through is a ledger in name only.
 */

export function archivePath(lens: LensName, month: string): string {
  return `/${lens}-${month}`;
}

export function renderArchive(
  lens: LensName,
  month: string,
  records: readonly EventRecord[],
  index: IndexBundle,
  meta: MetaRecord,
  heading: string,
): string {
  const rows = records
    .map(
      (event) => `<tr>
      <td class="dim">${esc(event.detectedAt.slice(0, 10))}</td>
      <td><a href="/repo/${esc(event.repo)}">${esc(event.repo)}</a></td>
      <td><a href="${esc(eventPath(event))}">${esc(eventDescription(event))}</a></td>
    </tr>`,
    )
    .join('');

  const body = `
<h1 class="label" style="padding:22px 0 4px">${esc(heading)} — ${esc(month)}, ${records.length} recorded</h1>
<div class="wrap"><table class="readout">
  <thead><tr><th scope="col">Date</th><th scope="col">Repository</th><th scope="col">Finding</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<div class="notice">
  Archived findings stay exactly as they were recorded. This month is also published as JSON at
  <a href="/data/${esc(lens)}-${esc(month)}.json">/data/${esc(lens)}-${esc(month)}.json</a>.
</div>`;

  return layout({
    title: `${heading} — ${month} — Sighttrue`,
    current: `/${lens}`,
    index,
    meta,
    description: `${records.length} ${heading.toLowerCase()} findings recorded in ${month}.`,
    path: archivePath(lens, month),
    body,
  });
}

/** Links to older months, for the foot of a lens page. */
export function archiveNav(lens: LensName, months: readonly string[]): string {
  if (months.length === 0) return '';

  const links = months
    .map((month) => `<a class="label" href="${esc(archivePath(lens, month))}">${esc(month)}</a>`)
    .join(' ');

  return `<div class="notice">
  <strong>Earlier</strong>
  Findings older than the window above, by month: ${links}
</div>`;
}
