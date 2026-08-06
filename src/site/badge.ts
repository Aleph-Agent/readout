/**
 * A badge per watched repository.
 *
 * The cheapest distribution this project has available. A maintainer who embeds
 * one puts a permanent link back in a README that may be read more in a week
 * than this site is read in a year — and it costs a static file.
 *
 * Which makes the wording load-bearing. A badge is quoted out of context by
 * definition: it appears on somebody else's page, with no caveats around it and
 * no way to click through to the disclosure. So it carries a figure that is
 * true standing alone, names its source, and makes no judgement at all. It says
 * what was measured, never whether that is good.
 *
 * SVG rather than a redirect to a badge service: no third party on somebody
 * else's README, nothing that can start charging, and nothing that can be taken
 * down and leave a broken image behind.
 */

import type { HealthRow } from '../types/health.ts';

/** Rough width for IBM Plex Sans Condensed 600 at 11px. */
function textWidth(text: string): number {
  let total = 0;
  for (const character of text) {
    total += /[iIl1.,:'`]/.test(character) ? 3 : /[A-Z0-9mwMW]/.test(character) ? 7.2 : 6;
  }
  return Math.ceil(total);
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface BadgeInput {
  repo: string;
  health: HealthRow | undefined;
  /** Weekly downloads across npm and PyPI, or null when nothing is mapped. */
  installs: number | null;
}

/**
 * The single figure a badge shows.
 *
 * One badge, one number. A badge with three figures on it is unreadable at the
 * size a README renders it, and picking the largest available reading is the
 * only ordering that does not require a judgement about which matters more.
 */
function reading(input: BadgeInput): { label: string; value: string } {
  if (input.installs !== null && input.installs > 0) {
    const millions = input.installs / 1_000_000;
    return {
      label: 'installs/wk',
      value:
        millions >= 1
          ? `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`
          : `${Math.round(input.installs / 1000)}k`,
    };
  }

  const score = input.health?.scorecard;
  if (typeof score === 'number') return { label: 'scorecard', value: `${score.toFixed(1)}/10` };

  // Watched, and nothing measurable yet. Saying so is still a true statement
  // and still links back; inventing a figure to fill the badge would not be.
  return { label: 'readout', value: 'watched' };
}

export function renderBadge(input: BadgeInput): string {
  const { label, value } = reading(input);

  const padding = 8;
  const labelWidth = textWidth(label) + padding * 2;
  const valueWidth = textWidth(value) + padding * 2;
  const width = labelWidth + valueWidth;
  const height = 20;

  // No gradient, no bevel, no rounded pill. The site's own two colours and its
  // own flat geometry, so a badge in the wild still looks like the instrument.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(input.repo)} — ${esc(label)} ${esc(value)}, measured by Readout</title>
  <rect width="${width}" height="${height}" fill="#0c0f08"/>
  <rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="#171c10"/>
  <rect x="${labelWidth}" width="2" height="${height}" fill="#ccff00"/>
  <g font-family="IBM Plex Sans Condensed,DejaVu Sans,Verdana,sans-serif" font-size="11" font-weight="600">
    <text x="${padding}" y="14" fill="#8e9683">${esc(label)}</text>
    <text x="${labelWidth + padding}" y="14" fill="#e6ebda">${esc(value)}</text>
  </g>
</svg>
`;
}
