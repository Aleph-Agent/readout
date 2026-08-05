import { describe, expect, it } from 'vitest';

import { assertSafeRepoId, isSafeRepoId } from '../src/lib/paths.ts';
import { stripSvg } from '../src/site/render.ts';
import type { StripMark } from '../src/types/bundles.ts';

function mark(over: Partial<StripMark> = {}): StripMark {
  return {
    id: 'a/one',
    name: 'a/one',
    delta: 0,
    multiplier: 1,
    capped: false,
    state: 'quiet',
    forks: 10,
    stars: 100,
    language: 'TypeScript',
    ...over,
  };
}

describe('repository id validation', () => {
  it('accepts the shapes GitHub actually uses', () => {
    for (const id of ['ollama/ollama', 'ggml-org/llama.cpp', '.github/.github', 'a16z/helios']) {
      expect(isSafeRepoId(id)).toBe(true);
    }
  });

  it('rejects ids that would escape the output directory', () => {
    // A repository id becomes dist/repo/{owner}/{name}.html. The obvious
    // owner/name shape accepts "../.." — two runs of legal name characters
    // with one slash between them — and that writes outside dist.
    for (const id of ['../..', 'a/..', '../x', '.', '..', 'a/../../b']) {
      expect(isSafeRepoId(id)).toBe(false);
    }
  });

  it('rejects separators that would create unintended nesting', () => {
    for (const id of ['a/b/c', 'a', 'a\\b', 'a/b c', '']) {
      expect(isSafeRepoId(id)).toBe(false);
    }
  });

  it('throws with the offending value quoted', () => {
    expect(() => assertSafeRepoId('../..')).toThrow(/unsafe repository id/);
  });
});

describe('the strip never hides an anomaly', () => {
  it('shows a spiking repository as spiking even when it also shipped', () => {
    // Nominal green would bury the reading behind the healthier-looking one.
    const svg = stripSvg([mark({ state: 'detected', multiplier: 8 })], new Set(['a/one']));
    expect(svg).toContain('mark-detected');
    expect(svg).not.toContain('mark-growth');
  });

  it('still marks a quiet repository that shipped', () => {
    const svg = stripSvg([mark()], new Set(['a/one']));
    expect(svg).toContain('mark-growth');
  });

  it('keeps confirmed above everything', () => {
    const svg = stripSvg([mark({ state: 'confirmed', multiplier: 30 })], new Set(['a/one']));
    expect(svg).toContain('mark-confirmed');
  });
});
