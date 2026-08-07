/**
 * The mark.
 *
 *   node scripts/build-mark.mjs
 *
 * Generated rather than hand-drawn because it is thirty-six ticks around a
 * circle, and thirty-six pairs of coordinates typed by hand is thirty-six
 * chances to be a degree out in a way nobody notices until it is printed.
 *
 * ## What it is
 *
 * A graduated dial with one reading past the rest.
 *
 * The old mark was crosshairs, which is the icon every monitoring product and
 * half the shooting ranges already use. It said "we look at things". It did not
 * say what this looks at or what it finds, and at 48 pixels it was a plus sign
 * in a circle.
 *
 * This says the product in one shape. A datum ring — the baseline every
 * repository is measured against, which is the "true" in the name. Graduations
 * standing off it, most of them short, because most of what this watches is
 * behaving normally and reporting that honestly is the job. And one mark that
 * runs past the edge, because the entire point is finding the one thing that
 * moved.
 *
 * It reads three ways at once and all three are on-brief: an aperture, which is
 * "sight"; a dial face, which is the instrument; and a distribution with one
 * outlier, which is the reading.
 *
 * ## What it is not
 *
 * Not data. The tick lengths are designed and fixed. A logo generated from
 * today's readings would change when they do, and a mark that is different on
 * Tuesday is not a mark. The banner carries the live strip; this carries the
 * idea of it.
 *
 * Every length is stated below rather than produced by a random function, so
 * the shape is reviewable and identical on every machine that builds it.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Thirty-six graduations, one every ten degrees.
 *
 * The distribution is deliberate: mostly quiet, a handful of mild movement, one
 * that breaks out. It is the shape of a real watchlist, drawn on purpose rather
 * than sampled from a day that happened to look good.
 *
 * Nothing is shorter than 2.5. Below that a tick disappears at avatar size and
 * the ring develops gaps that read as damage rather than as measurement.
 */
const TICKS = [
  3.0, 5.5, 3.5, 2.5, 7.0, 3.0, 2.5, 9.0, 4.0, 3.0, 5.0, 2.5,
  3.5, 8.0, 3.0, 2.5, 4.5, 3.5, 9.5, 3.0, 2.5, 6.0, 4.0, 3.0,
  7.5, 2.5, 3.5, 5.0, 3.0, 8.5, 2.5, 4.0, 6.5, 3.0, 2.5, 4.5,
];

/**
 * Which one breaks out. Index 30 puts it at 300 degrees — upper left.
 *
 * Not at twelve o'clock. A spike at the top reads as a pointer on a gauge,
 * which means "this is the current value"; off-axis it reads as one member of a
 * population that went somewhere the others did not, which is what it is.
 */
const BREAKOUT = 30;

const CENTRE = 32;
/**
 * The threshold, drawn as a bezel.
 *
 * It was inside at first, with the graduations growing outward off it, and that
 * is a sunburst — thirty-six spokes radiating from a hub, which is a loading
 * spinner or a sun and not an instrument. Real dials put the scale inside the
 * bezel.
 *
 * Turning it inside out also fixed the meaning. The ring is now the bar every
 * reading is measured against; everything inside is a repository behaving
 * normally, and the one mark crossing out through it is the finding. The shape
 * says what the software does instead of decorating it.
 */
const DATUM = 24;
/**
 * How far the outlier runs, outward, from the bar.
 *
 * Nothing else crosses the ring at all, so the length only has to be enough to
 * read as deliberate rather than as a stray stroke.
 */
const BREAK_TO = 31;

function tick(index, from, to) {
  // Twelve o'clock is -90 degrees in SVG, where 0 points right.
  const angle = ((index * 10 - 90) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const round = (n) => Number(n.toFixed(2));
  return {
    x1: round(CENTRE + cos * from),
    y1: round(CENTRE + sin * from),
    x2: round(CENTRE + cos * to),
    y2: round(CENTRE + sin * to),
  };
}

/**
 * `ink` and `alert` are passed in rather than fixed, so the same geometry
 * serves the light page, the dark page and a PNG that has to carry its own
 * colours. The site copy uses `currentColor` and inherits.
 */
function mark({ ink, alert, datum, title, simple = false }) {
  // Thirty-six graduations is right at 48px and mush at 16. A favicon that is a
  // shrunk copy of the full mark is a grey smudge with a pink fleck, so the
  // small variant drops to four cardinal marks and thickens everything — the
  // same idea, drawn with the strokes the size can actually carry.
  const strokes = simple
    ? { grad: 4, ring: 2.6, out: 4.5 }
    : { grad: 1.7, ring: 1.1, out: 2.4 };

  // Inward, off the bezel. Longer means closer to the bar without reaching it.
  const graduations = TICKS.map((length, index) => {
    if (index === BREAKOUT) return '';
    if (simple && index % 9 !== 0) return '';
    const { x1, y1, x2, y2 } = tick(index, DATUM, DATUM - (simple ? 8 : length));
    return `    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
  })
    .filter(Boolean)
    .join('\n');

  const out = tick(BREAKOUT, DATUM, BREAK_TO);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${title}">
  <title>${title}</title>

  <!--
    A graduated dial with one reading past the rest. Generated by
    scripts/build-mark.mjs, which explains every decision in it.

    The ring is the bar every reading is measured against — the "true" in the
    name. The graduations hang inside it, mostly short, because most of what
    this watches is behaving normally and reporting that honestly is the job.
    The one mark crossing out through the ring is the finding.

    One stroke weight for the graduations, one for the outlier, no gradient and
    no glow. Nothing here is thinner than 2 units, which is 1px at avatar size.
  -->

  <!-- The bar. Thinner and dimmer than the graduations inside it: a reference
       is not a reading and must not compete with one. A closed contour draws
       the eye harder than anything else on a shape this small, so it is held
       well back. -->
  <circle cx="${CENTRE}" cy="${CENTRE}" r="${DATUM}" fill="none"
          stroke="${datum}" stroke-width="${strokes.ring}" />

  <g stroke="${ink}" stroke-width="${strokes.grad}" stroke-linecap="butt">
${graduations}
  </g>

  <!-- The one that moved. Wider as well as longer, so it survives being resized
       to sixteen pixels by somebody else's favicon cache. -->
  <line x1="${out.x1}" y1="${out.y1}" x2="${out.x2}" y2="${out.y2}"
        stroke="${alert}" stroke-width="${strokes.out}" stroke-linecap="butt" />
</svg>
`;
}

/**
 * The repository copy inherits its colour, so one file works on both themes and
 * anywhere it is dropped into text.
 */
writeFileSync(
  `${ROOT}assets/brand/mark.svg`,
  mark({
    ink: 'currentColor',
    alert: 'currentColor',
    datum: 'currentColor',
    title: 'Sighttrue',
  }).replace(
    '<circle cx="32"',
    '<circle opacity="0.45" cx="32"',
  ),
  'utf8',
);

/**
 * The tab icon carries its own colours, because a favicon is drawn against
 * whatever chrome the browser has and cannot inherit anything.
 *
 * Dark-side colours: the mark is seen against a browser tab far more often than
 * against a page, and every tab strip worth designing for is dark or grey.
 */
writeFileSync(
  `${ROOT}src/site/favicon.svg`,
  mark({
    ink: '#d2e2f4',
    alert: '#f2857c',
    datum: '#8a8a8a',
    title: 'Sighttrue',
    simple: true,
  }),
  'utf8',
);

/** Fixed colours for the avatar, which is rasterised and has no page to inherit from. */
writeFileSync(
  `${ROOT}assets/brand/mark-dark.svg`,
  mark({ ink: '#d2e2f4', alert: '#f2857c', datum: '#5c5c5c', title: 'Sighttrue' }),
  'utf8',
);

console.log('mark.svg, favicon.svg and mark-dark.svg written');
