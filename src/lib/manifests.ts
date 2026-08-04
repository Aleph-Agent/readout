/**
 * Manifest selection and parsing.
 *
 * Pure: given a language and a file's text, return the dependency set. The
 * network side lives in the collector.
 *
 * Scope is deliberately narrow. This reads one manifest per repository, chosen
 * from the language GitHub already reported, and it reads it from the watchlist
 * only. It never searches GitHub globally — the Code Search API is capped at
 * ten requests a minute, and the claim this supports is "the repositories we
 * watch are moving toward X", not "the world is". The narrower claim is the
 * defensible one.
 */

/** Language to the single manifest worth fetching for it. */
const MANIFEST_BY_LANGUAGE: Record<string, string> = {
  javascript: 'package.json',
  typescript: 'package.json',
  vue: 'package.json',
  svelte: 'package.json',
  rust: 'Cargo.toml',
  go: 'go.mod',
  python: 'pyproject.toml',
};

export function manifestPathFor(language: string | null): string | null {
  if (language === null) return null;
  return MANIFEST_BY_LANGUAGE[language.toLowerCase()] ?? null;
}

interface PackageJson {
  dependencies?: Record<string, string>;
}

/**
 * Runtime dependencies only.
 *
 * devDependencies churn with tooling fashion and would drown the signal; what
 * a project ships with is the migration claim worth making.
 */
function parsePackageJson(text: string): Record<string, string> {
  try {
    const parsed = JSON.parse(text) as PackageJson;
    return parsed.dependencies ?? {};
  } catch {
    return {};
  }
}

/** `[dependencies]` in Cargo.toml, both bare versions and table form. */
function parseCargoToml(text: string): Record<string, string> {
  const deps: Record<string, string> = {};
  let inside = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inside = line === '[dependencies]';
      continue;
    }
    if (!inside || line === '' || line.startsWith('#')) continue;

    const match = /^([\w-]+)\s*=\s*(.+)$/.exec(line);
    if (match === null) continue;

    const value = (match[2] as string).trim();
    const version = /version\s*=\s*"([^"]+)"/.exec(value)?.[1] ?? /^"([^"]+)"/.exec(value)?.[1];
    deps[match[1] as string] = version ?? value.slice(0, 40);
  }

  return deps;
}

/** `require` directives in go.mod, block and single-line forms. */
function parseGoMod(text: string): Record<string, string> {
  const deps: Record<string, string> = {};
  let inBlock = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('require (')) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }

    const body = inBlock ? line : line.startsWith('require ') ? line.slice(8) : '';
    if (body === '' || body.startsWith('//')) continue;

    const match = /^(\S+)\s+(\S+)/.exec(body);
    if (match !== null) deps[match[1] as string] = match[2] as string;
  }

  return deps;
}

/** PEP 621 `[project] dependencies`, and Poetry's table form. */
function parsePyproject(text: string): Record<string, string> {
  const deps: Record<string, string> = {};

  const pep621 = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (pep621 !== null) {
    for (const raw of (pep621[1] as string).split(',')) {
      const quoted = /"([^"]+)"|'([^']+)'/.exec(raw);
      if (quoted === null) continue;
      const spec = (quoted[1] ?? quoted[2]) as string;
      const name = /^[A-Za-z0-9._-]+/.exec(spec)?.[0];
      if (name !== undefined) deps[name] = spec.slice(name.length).trim() || '*';
    }
  }

  const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(text);
  if (poetry !== null) {
    for (const raw of (poetry[1] as string).split(/\r?\n/)) {
      const match = /^([A-Za-z0-9._-]+)\s*=\s*(.+)$/.exec(raw.trim());
      if (match === null) continue;
      deps[match[1] as string] = (match[2] as string).replace(/["']/g, '').slice(0, 40);
    }
  }

  return deps;
}

export function parseManifest(path: string, text: string): Record<string, string> {
  if (path === 'package.json') return parsePackageJson(text);
  if (path === 'Cargo.toml') return parseCargoToml(text);
  if (path === 'go.mod') return parseGoMod(text);
  if (path === 'pyproject.toml') return parsePyproject(text);
  return {};
}

export interface DependencyDiff {
  added: string[];
  removed: string[];
  /** Dependencies whose major version moved. Patch churn is not a migration. */
  bumped: { name: string; from: string; to: string }[];
}

/** Leading integer of a version string, ignoring range operators. */
function majorOf(version: string): string | null {
  return /(\d+)/.exec(version.replace(/^[\^~>=<\s]+/, ''))?.[1] ?? null;
}

export function diffDependencies(
  before: Record<string, string>,
  after: Record<string, string>,
): DependencyDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const bumped: DependencyDiff['bumped'] = [];

  for (const name of Object.keys(after).sort()) {
    const previous = before[name];
    if (previous === undefined) {
      added.push(name);
      continue;
    }

    const from = majorOf(previous);
    const to = majorOf(after[name] as string);
    if (from !== null && to !== null && from !== to) {
      bumped.push({ name, from: previous, to: after[name] as string });
    }
  }

  for (const name of Object.keys(before).sort()) {
    if (after[name] === undefined) removed.push(name);
  }

  return { added, removed, bumped };
}
