import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '../src/types/watchlist.ts';
import type { Category, WatchlistEntry } from '../src/types/watchlist.ts';

/**
 * Assertions about the committed watchlist itself, not about the helpers that
 * write it. Read through an explicit path rather than the ledger so this stays
 * pinned to the real file even when another suite redirects `SIGNAL_DATA_DIR`.
 */
const WATCHLIST = fileURLToPath(new URL('../data/watchlist.jsonl', import.meta.url));

const raw = readFileSync(WATCHLIST, 'utf8');
const lines = raw.split('\n').filter((line) => line !== '');
const entries = lines.map((line) => JSON.parse(line) as WatchlistEntry);

describe('data/watchlist.jsonl', () => {
  it('holds 400 entries', () => {
    expect(entries).toHaveLength(400);
  });

  it('is stored LF-only with one trailing newline', () => {
    expect(raw).not.toContain('\r');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
  });

  it('is sorted by case-folded repository id', () => {
    const ids = entries.map((e) => e.id.toLowerCase());
    expect(ids).toEqual([...ids].sort());
  });

  it('has no duplicate repository, case-insensitively', () => {
    const ids = entries.map((e) => e.id.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names every repository as owner/repo', () => {
    const malformed = entries.filter((e) => !/^[\w.-]+\/[\w.-]+$/.test(e.id));
    expect(malformed.map((e) => e.id)).toEqual([]);
  });

  it('writes each line with the same keys in the same order', () => {
    const shapes = new Set(lines.map((line) => Object.keys(JSON.parse(line) as object).join(',')));
    expect([...shapes]).toEqual(['id,category,added,active']);
  });

  it('uses only declared categories, and covers all five', () => {
    const used = new Set(entries.map((e) => e.category));
    expect([...used].sort()).toEqual([...CATEGORIES].sort());
  });

  it('spreads across categories rather than leaning on one', () => {
    const counts = new Map<Category, number>();
    for (const e of entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    for (const category of CATEGORIES) {
      expect(counts.get(category) ?? 0).toBeGreaterThanOrEqual(50);
    }
  });

  it('dates every entry', () => {
    expect(entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.added))).toBe(true);
  });

  it('retires entries rather than deleting them', () => {
    // Removing one would erase the record that it was ever watched, and the
    // findings collected while it was still link to it. Archived and deleted
    // repositories stay on the list with active: false.
    const retired = entries.filter((e) => !e.active);
    expect(retired.length).toBeLessThan(entries.length / 4);
    expect(entries.filter((e) => e.active).length).toBeGreaterThan(300);
  });
});
