/**
 * The dependency check, as a GitHub Action.
 *
 * This is the only distribution channel here that does not require anybody to
 * visit a website. A badge waits to be embedded and a page waits to be opened;
 * this runs in somebody's pipeline every day and speaks up when something they
 * depend on changes underneath them.
 *
 * It is also the only way to be a monitoring service at zero infrastructure
 * cost: the user's own CI is the scheduler, their own repository is the state,
 * and nothing here stores anything.
 *
 * Plain ESM with no dependencies, run by the Node that is already on every
 * runner. An action that needs `npm install` to tell you your dependencies are
 * risky has missed its own point.
 *
 * Failure policy: a network problem is not a finding. If the readings cannot be
 * fetched the step says so and passes, because a build that breaks when a
 * third-party site is down is a build nobody keeps.
 */

import { readFileSync, appendFileSync } from 'node:fs';

const endpoint = (process.env.READOUT_ENDPOINT || 'https://readout-7pt.pages.dev').replace(/\/$/, '');
const manifestPath = process.env.READOUT_MANIFEST || 'package.json';
const failOn = new Set(
  (process.env.READOUT_FAIL_ON || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean),
);

const OSV_ECOSYSTEM = { npm: 'npm', pypi: 'PyPI', crates: 'crates.io' };
const SOURCE_AVAILABLE = /BUSL|SSPL|Elastic|RSAL|Commons-Clause|PolyForm/i;

function registryFor(path) {
  const explicit = (process.env.READOUT_REGISTRY || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (path.endsWith('Cargo.toml')) return 'crates';
  if (path.endsWith('package.json')) return 'npm';
  return 'pypi';
}

/**
 * Deliberately forgiving. A real manifest carries comments, version ranges and
 * extras, and refusing one for not being clean JSON would fail exactly the
 * repositories this is for.
 */
function names(text, registry) {
  const found = new Set();

  if (registry === 'npm') {
    try {
      const pkg = JSON.parse(text);
      for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of Object.keys(pkg[group] || {})) found.add(name);
      }
      return [...found];
    } catch {
      return [];
    }
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith('[') || line.startsWith('-')) continue;

    if (registry === 'crates') {
      const match = /^([A-Za-z0-9._-]+)\s*=/.exec(line);
      if (match) found.add(match[1]);
    } else {
      const match = /^([A-Za-z0-9._-]+)\s*(?:[=<>!~[]|$)/.exec(line);
      if (match) found.add(match[1].toLowerCase());
    }
  }

  return [...found];
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response.json();
}

async function advisories(registry, packages) {
  const counts = new Map();
  const ecosystem = OSV_ECOSYSTEM[registry];
  if (!ecosystem) return counts;

  for (let i = 0; i < packages.length; i += 100) {
    const slice = packages.slice(i, i + 100);
    const body = await getJson('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: slice.map((name) => ({ package: { name, ecosystem } })),
      }),
    });
    (body.results || []).forEach((result, index) => {
      counts.set(slice[index], (result.vulns || []).length);
    });
  }

  return counts;
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  for (const line of lines) process.stdout.write(`${line.replace(/[*`]/g, '')}\n`);
}

async function main() {
  const registry = registryFor(manifestPath);

  let text;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    summary([`### Readout`, ``, `No manifest at \`${manifestPath}\`. Nothing checked.`]);
    return;
  }

  const packages = names(text, registry);
  if (packages.length === 0) {
    summary([`### Readout`, ``, `No dependencies found in \`${manifestPath}\`.`]);
    return;
  }

  let index;
  let osv = new Map();
  try {
    index = await getJson(`${endpoint}/data/stack-index.json`);
    osv = await advisories(registry, packages);
  } catch (error) {
    // A network problem is not a finding, and a build that breaks when someone
    // else's site is down is a build that gets removed.
    summary([`### Readout`, ``, `Readings unavailable (${error.message}). Nothing failed.`]);
    return;
  }

  const archived = [];
  const relicensed = [];
  const risky = [];
  let total = 0;
  let tracked = 0;

  for (const name of packages) {
    const hit = index.packages?.[`${registry}:${name}`];
    const count = osv.get(name) ?? hit?.advisories ?? 0;
    total += count;
    if (count > 0) risky.push(`${name} (${count})`);
    if (!hit) continue;

    tracked += 1;
    if (hit.archived) archived.push(name);
    if (hit.license && SOURCE_AVAILABLE.test(hit.license)) {
      relicensed.push(`${name} (${hit.license})`);
    }
  }

  const lines = [
    `### Readout`,
    ``,
    `${packages.length} dependencies read, ${tracked} with full readings.`,
    ``,
  ];
  const section = (title, items) => {
    if (items.length === 0) return;
    lines.push(`**${title}**`, ``, ...items.map((item) => `- ${item}`), ``);
  };

  section('Archived', archived);
  section('Source-available licence', relicensed);
  section('Advisories on record', risky);

  if (archived.length + relicensed.length + risky.length === 0) {
    lines.push(`Nothing to report.`, ``);
  }
  lines.push(`Advisory counts are all time — a mature project carries more than a young one.`);
  summary(lines);

  output('archived', archived.join(','));
  output('relicensed', relicensed.join(','));
  output('advisories', String(total));

  const failed = [
    failOn.has('archived') && archived.length > 0 ? `${archived.length} archived` : '',
    failOn.has('relicensed') && relicensed.length > 0 ? `${relicensed.length} relicensed` : '',
    failOn.has('advisories') && risky.length > 0 ? `${risky.length} with advisories` : '',
  ].filter(Boolean);

  if (failed.length > 0) {
    process.stdout.write(`\nFailing: ${failed.join(', ')}\n`);
    process.exitCode = 1;
  }
}

await main();
