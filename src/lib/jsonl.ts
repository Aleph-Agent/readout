import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Deterministic JSONL. Writing the same data twice must produce byte-identical
 * output, on any machine, in any locale.
 *
 * That is not tidiness. The agent commits six times a day forever. If a write
 * can reorder keys, reorder rows, or emit a different line ending, every commit
 * stores a full copy of every file instead of a delta, and the repository grows
 * without bound. Every rule below exists to remove one source of variance.
 */

/** Ordering by UTF-16 code unit. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recursively normalise a value into something JSON.stringify renders
 * identically every time.
 *
 * - `undefined` becomes `null`, so a missing field is still a present key. A
 *   varying row shape would defeat line-level diffs.
 * - Nested object keys are sorted, because insertion order for a
 *   collector-built `Record` is not stable across runs. Top-level order comes
 *   from the declared tuple instead and is never sorted.
 * - Non-finite numbers throw. NaN and Infinity serialise to `null`, which would
 *   silently turn a broken calculation into a published number.
 */
function canonicalise(value: unknown, path: string): unknown {
  if (value === undefined) return null;
  if (value === null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalise: ${path} is ${String(value)}, not a finite number`);
    }
    return value;
  }

  if (typeof value === 'string' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map((item, i) => canonicalise(item, `${path}[${i}]`));
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareCodeUnits)) {
      out[key] = canonicalise(source[key], `${path}.${key}`);
    }
    return out;
  }

  throw new Error(`canonicalise: ${path} has unserialisable type ${typeof value}`);
}

/**
 * Render one record as a single line, emitting exactly the declared keys in
 * exactly the declared order.
 *
 * Throws on a key the tuple does not mention. The compile-time guard in
 * `src/types/keys.ts` catches this for statically typed callers; this catches
 * it for data that arrived as JSON at runtime.
 */
export function serialiseRow<T extends object>(
  row: T,
  keyOrder: readonly (keyof T & string)[],
): string {
  for (const key of Object.keys(row)) {
    if (!(keyOrder as readonly string[]).includes(key)) {
      throw new Error(`serialiseRow: key "${key}" is not in the declared key order`);
    }
  }

  const ordered: Record<string, unknown> = {};
  for (const key of keyOrder) {
    ordered[key] = canonicalise(row[key], key);
  }

  const line = JSON.stringify(ordered);
  if (line.includes('\n')) {
    throw new Error('serialiseRow: rendered line contains a newline');
  }
  return line;
}

/**
 * Replace a file in one step: write a sibling temp file, then rename over the
 * target. A run killed mid-write leaves the previous ledger intact rather than
 * a truncated one.
 */
export function writeFileAtomic(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, contents, 'utf8');
  renameSync(temp, filePath);
}

/**
 * Parse a JSONL file. Missing file reads as empty — a collector that has never
 * run is not an error.
 *
 * Splits on `\r?\n` defensively. Nothing here ever writes CRLF, but a checkout
 * on a machine with `core.autocrlf` set and no `.gitattributes` would produce
 * it, and failing to parse would be a confusing way to discover that.
 */
export function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const rows: T[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`readJsonl: ${filePath}:${index + 1} is not valid JSON`);
    }
  }

  return rows;
}

export interface WriteJsonlOptions<T> {
  /**
   * Sort key per row. Omit to preserve caller order — correct for append-only
   * event files, where sorting would reshuffle history on every write.
   */
  sortBy?: (row: T) => string;
  /** Reject two rows sharing a sort key. Requires `sortBy`. */
  rejectDuplicates?: boolean;
}

/**
 * Overwrite a JSONL file deterministically: sorted rows, fixed key order, LF
 * endings, one trailing newline, and an empty file for zero rows.
 */
export function writeJsonl<T extends object>(
  filePath: string,
  rows: readonly T[],
  keyOrder: readonly (keyof T & string)[],
  options: WriteJsonlOptions<T> = {},
): void {
  const { sortBy, rejectDuplicates = false } = options;

  let ordered = [...rows];
  if (sortBy) {
    ordered.sort((a, b) => compareCodeUnits(sortBy(a), sortBy(b)));

    if (rejectDuplicates) {
      for (let i = 1; i < ordered.length; i += 1) {
        const previous = sortBy(ordered[i - 1] as T);
        const current = sortBy(ordered[i] as T);
        if (previous === current) {
          throw new Error(`writeJsonl: duplicate sort key "${current}" in ${filePath}`);
        }
      }
    }
  }

  const body = ordered.map((row) => serialiseRow(row, keyOrder)).join('\n');
  writeFileAtomic(filePath, body === '' ? '' : `${body}\n`);
}

/**
 * Add rows to the end of a JSONL file, leaving every existing byte untouched.
 *
 * Refuses to append to a file that does not end in a newline: that means a
 * previous write was interrupted, and appending would splice two records into
 * one corrupt line.
 */
export function appendJsonl<T extends object>(
  filePath: string,
  rows: readonly T[],
  keyOrder: readonly (keyof T & string)[],
): void {
  if (rows.length === 0) return;

  mkdirSync(dirname(filePath), { recursive: true });

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8');
    if (existing !== '' && !existing.endsWith('\n')) {
      throw new Error(
        `appendJsonl: ${filePath} does not end with a newline; refusing to append to a truncated file`,
      );
    }
  }

  const body = rows.map((row) => serialiseRow(row, keyOrder)).join('\n');
  appendFileSync(filePath, `${body}\n`, 'utf8');
}

/**
 * Reshape a record read from disk to exactly the keys the schema declares.
 *
 * Renaming a field in code leaves the old name sitting in the committed file.
 * Spreading that into the next write carries the stale key along, and the
 * key-order guard rejects it — taking down a run that had nothing wrong with
 * it. Dropping unknown keys on the way in makes a rename survivable: the file
 * heals on the next write instead of blocking it.
 *
 * Keys the file is missing come back undefined, which serialises as null. A
 * schema that grew a field reads old rows as having none, which is true.
 */
export function conform<T extends object>(
  row: unknown,
  keyOrder: readonly (keyof T & string)[],
): T {
  const source = (row ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keyOrder) out[key] = source[key];
  return out as T;
}

/** Read a single JSON object, or null when the file does not exist. */
export function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`readJson: ${filePath} is not valid JSON`);
  }
}

/**
 * Write a single JSON object with declared key order, two-space indent, and a
 * trailing newline. Indented rather than minified because this one is read by
 * humans debugging a run.
 */
export function writeJson<T extends object>(
  filePath: string,
  value: T,
  keyOrder: readonly (keyof T & string)[],
): void {
  for (const key of Object.keys(value)) {
    if (!(keyOrder as readonly string[]).includes(key)) {
      throw new Error(`writeJson: key "${key}" is not in the declared key order`);
    }
  }

  const ordered: Record<string, unknown> = {};
  for (const key of keyOrder) {
    ordered[key] = canonicalise(value[key], key);
  }

  writeFileAtomic(filePath, `${JSON.stringify(ordered, null, 2)}\n`);
}
