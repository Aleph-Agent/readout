import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The palette, measured rather than looked at.
 *
 * Colour on this site is not decoration — it encodes magnitude and it encodes
 * two states, and a step nobody can see is a reading nobody can take. Every
 * value was checked with a calculator once. This checks them on every run, in
 * both themes, from the stylesheet itself, so the numbers in the comments
 * cannot drift away from the numbers in the file.
 *
 * Reads the CSS rather than a duplicated table on purpose. A test holding its
 * own copy of the palette passes forever while the site turns unreadable.
 */

const CSS = readFileSync(fileURLToPath(new URL('../src/site/site.css', import.meta.url)), 'utf8');

type Theme = 'light' | 'dark';

/**
 * Every `--token: light-dark(a, b)` in the stylesheet, both sides.
 *
 * The dark values are also declared plainly above the `@supports` block, as the
 * floor for a browser without the function. Those are read too, and asserted to
 * agree — two sources for one colour is exactly how a theme drifts.
 */
function themedTokens(): Map<string, Record<Theme, string>> {
  const found = new Map<string, Record<Theme, string>>();
  const pattern = /--([a-z0-9-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi;

  for (const match of CSS.matchAll(pattern)) {
    found.set(match[1] as string, { light: match[2] as string, dark: match[3] as string });
  }

  return found;
}

function plainDark(token: string): string | null {
  const match = new RegExp(`--${token}:\\s*(#[0-9a-f]{6});`, 'i').exec(CSS);
  return match === null ? null : (match[1] as string).toLowerCase();
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function linear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** Viénot-Brettel-Mollon, the standard linear approximation. */
const CVD: Record<string, readonly (readonly [number, number, number])[]> = {
  protanopia: [
    [0.1121, 0.8853, -0.0005],
    [0.1127, 0.8897, -0.0001],
    [0.0045, 0.0, 1.0019],
  ],
  deuteranopia: [
    [0.292, 0.7054, -0.0003],
    [0.2934, 0.7089, 0.0001],
    [-0.0195, 0.0333, 0.9912],
  ],
  tritanopia: [
    [1.0164, 0.115, -0.1563],
    [0.0859, 0.8788, 0.0369],
    [-0.0073, 0.0691, 0.9375],
  ],
};

function simulate(hex: string, matrix: readonly (readonly [number, number, number])[]): number[] {
  const source = channels(hex).map(linear);
  return matrix.map((row) =>
    Math.min(1, Math.max(0, row[0] * (source[0] as number) + row[1] * (source[1] as number) + row[2] * (source[2] as number))),
  );
}

function lab(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(a: readonly number[], b: readonly number[]): number {
  const left = lab(a);
  const right = lab(b);
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

const TOKENS = themedTokens();
const THEMES: Theme[] = ['light', 'dark'];

function value(token: string, theme: Theme): string {
  const pair = TOKENS.get(token);
  if (pair === undefined) throw new Error(`--${token} is not themed in site.css`);
  return pair[theme];
}

const MAGNITUDE = ['mag-1', 'mag-2', 'mag-3', 'mag-4', 'mag-5'];

describe('the palette is stated in both themes', () => {
  it('themes the whole ramp, both signals, and the magnitude steps', () => {
    const required = [
      'ink-000',
      'ink-025',
      'ink-050',
      'ink-100',
      'ink-200',
      'ink-300',
      'ink-500',
      'ink-700',
      'ink-900',
      'alert',
      'nominal',
      ...MAGNITUDE,
    ];

    for (const token of required) {
      expect(TOKENS.has(token), `--${token} has no light-dark() pair`).toBe(true);
    }
  });

  it('keeps the no-support fallback equal to the dark side', () => {
    // Two declarations of one colour. If they disagree, a browser without
    // `light-dark()` renders a palette nobody designed.
    for (const [token, pair] of TOKENS) {
      const fallback = plainDark(token);
      if (fallback === null) continue;
      expect(fallback, `--${token} fallback disagrees with its dark value`).toBe(
        pair.dark.toLowerCase(),
      );
    }
  });
});

describe.each(THEMES)('%s theme', (theme) => {
  const ground = value('ink-000', theme);

  it('carries body and label text at 4.5:1 or better', () => {
    for (const token of ['ink-500', 'ink-700', 'ink-900']) {
      const ratio = contrast(value(token, theme), ground);
      expect(ratio, `--${token} is ${ratio.toFixed(2)}:1 on the ground`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('carries both signal colours at 4.5:1 or better', () => {
    // These are read as text — an alert figure, a nominal label — not just as
    // fills, so the text bar applies to them and not the 3:1 one.
    for (const token of ['alert', 'nominal']) {
      const ratio = contrast(value(token, theme), ground);
      expect(ratio, `--${token} is ${ratio.toFixed(2)}:1 on the ground`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps every magnitude step visible against the ground', () => {
    for (const token of MAGNITUDE) {
      const ratio = contrast(value(token, theme), ground);
      expect(ratio, `--${token} is ${ratio.toFixed(2)}:1 on the ground`).toBeGreaterThanOrEqual(3);
    }
  });

  it('orders the magnitude ramp away from the ground, step by step', () => {
    // A sequential ramp has no confusion pairs only while it stays ordered by
    // lightness. Direction flips with the theme: on dark, brighter is more; on
    // light, darker is more. Both are "further from the ground".
    const distances = MAGNITUDE.map((token) =>
      Math.abs(luminance(value(token, theme)) - luminance(ground)),
    );

    for (let i = 1; i < distances.length; i += 1) {
      expect(
        distances[i] as number,
        `${MAGNITUDE[i]} is not further from the ground than ${MAGNITUDE[i - 1]}`,
      ).toBeGreaterThan(distances[i - 1] as number);
    }
  });

  it('separates the two signal colours under every colour vision deficiency', () => {
    const alert = value('alert', theme);
    const nominal = value('nominal', theme);

    for (const [kind, matrix] of Object.entries(CVD)) {
      const separation = deltaE(simulate(alert, matrix), simulate(nominal, matrix));
      expect(separation, `alert and nominal are deltaE ${separation.toFixed(1)} under ${kind}`).toBeGreaterThanOrEqual(15);
    }
  });

  it('separates the ground from the surfaces stacked on it', () => {
    // The failure that four palette rewrites could not fix: page, panel and
    // raised surface within six points of luminance, so the whole thing read
    // flat whatever the accent did.
    const steps = ['ink-000', 'ink-025', 'ink-050', 'ink-100'].map((token) =>
      luminance(value(token, theme)),
    );

    for (let i = 1; i < steps.length; i += 1) {
      const apart = Math.abs((steps[i] as number) - (steps[i - 1] as number));
      expect(apart, `surface step ${i} is ${apart.toFixed(4)} from the one below`).toBeGreaterThan(
        0.004,
      );
    }
  });
});
