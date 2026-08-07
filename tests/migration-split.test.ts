import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — a plain .mjs script with no types, imported for the one
// pure function in it. Typing the whole configure script to test its splitter
// would be the tail wagging the dog.
import { statements } from '../scripts/configure-d1.mjs';

/**
 * The migration, cut into the statements that get sent to D1.
 *
 * D1's REST API takes one statement per request, so the file has to be split —
 * and the split is code, which means it can be wrong. It was: semicolons were
 * removed before comments, so the file was cut at the semicolon inside the
 * comment explaining why accounts key on the numeric id. The first statement
 * ended halfway through its own column list, and D1 answered "incomplete
 * input", which is accurate and points nowhere.
 *
 * The test that would have caught it is the obvious one: feed the pieces to a
 * real SQLite and see whether they build the schema.
 */

const SQL = readFileSync(
  fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)),
  'utf8',
);

describe('splitting the migration', () => {
  const parts: string[] = statements(SQL);

  it('produces statements that a real database accepts', () => {
    // The whole point. Not "looks like SQL" — runs as SQL, one call at a time,
    // exactly as D1 will receive it.
    const db = new DatabaseSync(':memory:');
    for (const part of parts) expect(() => db.exec(part)).not.toThrow();

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);

    for (const wanted of [
      'accounts',
      'api_keys',
      'entitlements',
      'invoices',
      'payments',
      'sessions',
      'watch_items',
      'watchlists',
    ]) {
      expect(tables).toContain(wanted);
    }
  });

  it('is not fooled by a semicolon inside a comment', () => {
    // The exact bug, held still. Every piece must be balanced; a statement cut
    // mid-definition has more open parentheses than closed ones.
    for (const part of parts) {
      const open = (part.match(/\(/g) ?? []).length;
      const close = (part.match(/\)/g) ?? []).length;
      expect(open, `unbalanced: ${part.split('\n')[0]}`).toBe(close);
    }
  });

  it('keeps the comment that caused it, so the case stays covered', () => {
    // If somebody tidies that semicolon away, this test starts passing for the
    // wrong reason and the splitter is never exercised against the hazard again.
    expect(SQL).toMatch(/--[^\n]*;/);
  });

  it('sends no PRAGMA, which D1 refuses over the query API', () => {
    for (const part of parts) expect(part).not.toMatch(/^PRAGMA/i);
  });

  it('sends nothing empty', () => {
    for (const part of parts) expect(part.trim()).not.toBe('');
  });
});
