import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendJsonl,
  compareCodeUnits,
  readJsonl,
  serialiseRow,
  writeJsonl,
} from '../src/lib/jsonl.ts';

interface Row {
  id: string;
  count: number;
  label: string | null;
}

const ROW_KEYS = ['id', 'count', 'label'] as const;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'signal-jsonl-'));
  file = join(dir, 'rows.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('serialiseRow', () => {
  it('emits the declared key order regardless of insertion order', () => {
    const a = serialiseRow({ id: 'x', count: 1, label: null }, ROW_KEYS);
    const b = serialiseRow({ label: null, count: 1, id: 'x' }, ROW_KEYS);

    expect(a).toBe('{"id":"x","count":1,"label":null}');
    expect(b).toBe(a);
  });

  it('rejects a key missing from the declared order', () => {
    const rogue = { id: 'x', count: 1, label: null, extra: true } as unknown as Row;
    expect(() => serialiseRow(rogue, ROW_KEYS)).toThrow(/not in the declared key order/);
  });

  it('writes undefined as an explicit null so the row shape never varies', () => {
    const sparse = { id: 'x', count: 1, label: undefined } as unknown as Row;
    expect(serialiseRow(sparse, ROW_KEYS)).toBe('{"id":"x","count":1,"label":null}');
  });

  it('throws on non-finite numbers instead of publishing null', () => {
    // JSON.stringify turns NaN into null, which would quietly promote a broken
    // calculation into a number on the site.
    expect(() => serialiseRow({ id: 'x', count: NaN, label: null }, ROW_KEYS)).toThrow(
      /not a finite number/,
    );
    expect(() =>
      serialiseRow({ id: 'x', count: Infinity, label: null }, ROW_KEYS),
    ).toThrow(/not a finite number/);
  });

  it('sorts nested object keys, whose insertion order is not stable across runs', () => {
    interface Nested {
      id: string;
      metrics: Record<string, number>;
    }
    const keys = ['id', 'metrics'] as const;

    const a = serialiseRow<Nested>({ id: 'x', metrics: { forks: 2, baseline: 1 } }, keys);
    const b = serialiseRow<Nested>({ id: 'x', metrics: { baseline: 1, forks: 2 } }, keys);

    expect(a).toBe('{"id":"x","metrics":{"baseline":1,"forks":2}}');
    expect(b).toBe(a);
  });
});

describe('compareCodeUnits', () => {
  it('orders by code unit, not by locale', () => {
    // en-US collation puts "a" before "B"; code-unit order does not. Using
    // localeCompare here would make output depend on the machine's locale.
    expect(compareCodeUnits('B', 'a')).toBeLessThan(0);
    expect('B'.localeCompare('a')).toBeGreaterThan(0);
  });
});

describe('writeJsonl', () => {
  const rows: Row[] = [
    { id: 'c', count: 3, label: 'gamma' },
    { id: 'a', count: 1, label: null },
    { id: 'b', count: 2, label: 'beta' },
  ];

  it('produces a byte-identical file when the same data is written twice', () => {
    writeJsonl(file, rows, ROW_KEYS, { sortBy: (r) => r.id });
    const first = readFileSync(file);

    writeJsonl(file, rows, ROW_KEYS, { sortBy: (r) => r.id });
    const second = readFileSync(file);

    expect(second.equals(first)).toBe(true);
  });

  it('is stable under input reordering', () => {
    writeJsonl(file, rows, ROW_KEYS, { sortBy: (r) => r.id });
    const sorted = readFileSync(file);

    const shuffled = [rows[1] as Row, rows[2] as Row, rows[0] as Row];
    writeJsonl(file, shuffled, ROW_KEYS, { sortBy: (r) => r.id });

    expect(readFileSync(file).equals(sorted)).toBe(true);
  });

  it('emits LF only, with exactly one trailing newline', () => {
    writeJsonl(file, rows, ROW_KEYS, { sortBy: (r) => r.id });
    const raw = readFileSync(file, 'utf8');

    expect(raw).not.toContain('\r');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
    expect(raw.split('\n').filter((l) => l !== '')).toHaveLength(3);
  });

  it('writes an empty file for zero rows rather than a stray newline', () => {
    writeJsonl<Row>(file, [], ROW_KEYS, { sortBy: (r) => r.id });
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('preserves caller order when no sort key is given', () => {
    writeJsonl(file, rows, ROW_KEYS);
    const ids = readJsonl<Row>(file).map((r) => r.id);
    expect(ids).toEqual(['c', 'a', 'b']);
  });

  it('rejects duplicate sort keys when asked', () => {
    const dupes: Row[] = [
      { id: 'a', count: 1, label: null },
      { id: 'a', count: 2, label: null },
    ];
    expect(() =>
      writeJsonl(file, dupes, ROW_KEYS, { sortBy: (r) => r.id, rejectDuplicates: true }),
    ).toThrow(/duplicate sort key "a"/);
  });
});

describe('readJsonl', () => {
  it('reads a missing file as empty', () => {
    expect(readJsonl<Row>(join(dir, 'never-written.jsonl'))).toEqual([]);
  });

  it('round trips through write and read', () => {
    const rows: Row[] = [
      { id: 'a', count: 1, label: null },
      { id: 'b', count: 2, label: 'beta' },
    ];
    writeJsonl(file, rows, ROW_KEYS, { sortBy: (r) => r.id });
    expect(readJsonl<Row>(file)).toEqual(rows);
  });

  it('still parses a file that a stray CRLF checkout mangled', () => {
    writeFileSync(file, '{"id":"a","count":1,"label":null}\r\n', 'utf8');
    expect(readJsonl<Row>(file)).toEqual([{ id: 'a', count: 1, label: null }]);
  });

  it('names the line when a file is corrupt', () => {
    writeFileSync(file, '{"id":"a"}\nnot json\n', 'utf8');
    expect(() => readJsonl<Row>(file)).toThrow(/:2 is not valid JSON/);
  });
});

describe('appendJsonl', () => {
  it('leaves every existing byte untouched', () => {
    appendJsonl(file, [{ id: 'a', count: 1, label: null }], ROW_KEYS);
    const before = readFileSync(file);

    appendJsonl(file, [{ id: 'b', count: 2, label: null }], ROW_KEYS);
    const after = readFileSync(file);

    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    expect(readJsonl<Row>(file)).toHaveLength(2);
  });

  it('does nothing for an empty batch', () => {
    appendJsonl(file, [{ id: 'a', count: 1, label: null }], ROW_KEYS);
    const before = readFileSync(file);

    appendJsonl(file, [], ROW_KEYS);

    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses to append to a file left truncated by an interrupted write', () => {
    writeFileSync(file, '{"id":"a","count":1,"label":null}', 'utf8');
    expect(() => appendJsonl(file, [{ id: 'b', count: 2, label: null }], ROW_KEYS)).toThrow(
      /refusing to append to a truncated file/,
    );
  });
});
