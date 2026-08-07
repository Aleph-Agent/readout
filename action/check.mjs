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
 * third-party site is down is a build nobody keeps. The same applies to posting
 * the review comment: a comment that cannot be posted is not a reason to fail
 * somebody's pipeline.
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const endpoint = (process.env.READOUT_ENDPOINT || 'https://sighttrue.com').replace(/\/$/, '');
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
    const osv = (process.env.READOUT_OSV || 'https://api.osv.dev').replace(/\/$/, '');
    const body = await getJson(`${osv}/v1/querybatch`, {
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

/**
 * How the comment finds itself again.
 *
 * Invisible in the rendered comment, and the only reliable handle: matching on
 * the author would collide with every other action running as the same bot, and
 * matching on the text would break the first time the wording changed.
 */
const MARKER = '<!-- readout-dependency-check -->';

/** The pull request this run belongs to, or null when it is not one. */
function pullRequestNumber() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (path) {
    try {
      const event = JSON.parse(readFileSync(path, 'utf8'));
      const number = event.pull_request?.number ?? event.issue?.number;
      if (Number.isInteger(number)) return number;
    } catch {
      // Falls through to the ref, which is the same answer by another route.
    }
  }

  const match = /^refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF || '');
  return match ? Number(match[1]) : null;
}

async function github(token, method, path, body) {
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) throw new Error(`${response.status} ${method} ${path}`);
  return response.status === 204 ? null : response.json();
}

/**
 * One comment per pull request, rewritten in place.
 *
 * A new comment on every push turns a busy branch into a wall of near-identical
 * reports, which is how a useful check gets muted. Finding the previous one and
 * editing it means the thread holds the current reading and nothing else.
 *
 * A clean run still rewrites an existing comment rather than deleting it. A
 * warning that silently disappears leaves a reviewer unsure whether it was
 * fixed or the check stopped running, and those are different facts.
 */
async function comment(body) {
  if ((process.env.READOUT_COMMENT || 'true').toLowerCase() === 'false') return;

  const token = process.env.READOUT_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const number = pullRequestNumber();
  if (!token || !repository || number === null) return;

  const contents = `${MARKER}\n${body}`;

  try {
    const existing = await github(
      token,
      'GET',
      `/repos/${repository}/issues/${number}/comments?per_page=100`,
    );
    const mine = (existing || []).find((entry) => (entry.body || '').includes(MARKER));

    if (mine) {
      await github(token, 'PATCH', `/repos/${repository}/issues/comments/${mine.id}`, {
        body: contents,
      });
    } else {
      await github(token, 'POST', `/repos/${repository}/issues/${number}/comments`, {
        body: contents,
      });
    }
  } catch (error) {
    // A pull request from a fork gets a read-only token, so this is the normal
    // outcome there rather than a fault. Said once, quietly, and never fatal:
    // the findings are already in the step summary and the outputs.
    process.stdout.write(`Comment not posted (${error.message}). Findings are in the summary.\n`);
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
    summary([`### Sighttrue`, ``, `No manifest at \`${manifestPath}\`. Nothing checked.`]);
    return;
  }

  const packages = names(text, registry);
  if (packages.length === 0) {
    summary([`### Sighttrue`, ``, `No dependencies found in \`${manifestPath}\`.`]);
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
    //
    // Deliberately does not touch the pull request comment. Rewriting it here
    // would replace yesterday's "three archived" with "readings unavailable"
    // and quietly retract a true finding because of an unrelated outage.
    summary([`### Sighttrue`, ``, `Readings unavailable (${error.message}). Nothing failed.`]);
    return;
  }

  const archived = [];
  const relicensed = [];
  const risky = [];
  const rows = [];
  let total = 0;
  let tracked = 0;

  for (const name of packages) {
    const hit = index.packages?.[`${registry}:${name}`];
    const count = osv.get(name) ?? hit?.advisories ?? 0;
    total += count;
    if (count > 0) risky.push(`${name} (${count})`);

    const flags = [];
    if (count > 0) flags.push(`${count} ${count === 1 ? 'advisory' : 'advisories'}`);

    if (hit) {
      tracked += 1;
      if (hit.archived) {
        archived.push(name);
        flags.push('archived');
      }
      if (hit.license && SOURCE_AVAILABLE.test(hit.license)) {
        relicensed.push(`${name} (${hit.license})`);
        flags.push(`licence now ${hit.license}`);
      }
    }

    if (flags.length > 0) {
      rows.push({
        name,
        flags,
        // Only tracked packages have a page. A link to a 404 is worse than no
        // link, and an untracked package is not being judged anyway.
        repo: hit?.repo ?? null,
      });
    }
  }

  const lines = [
    `### Sighttrue`,
    ``,
    `${packages.length} ${registry} ${packages.length === 1 ? 'dependency' : 'dependencies'} read, ${tracked} with full readings.`,
    ``,
  ];

  if (rows.length === 0) {
    lines.push(
      `Nothing to report. Nothing here is archived, relicensed, or carrying an advisory.`,
      ``,
    );
  } else {
    lines.push(`| Dependency | What changed |`, `| --- | --- |`);
    for (const row of rows) {
      const label =
        row.repo === null
          ? `\`${row.name}\``
          : `[\`${row.name}\`](${endpoint}/repo/${row.repo})`;
      lines.push(`| ${label} | ${row.flags.join(', ')} |`);
    }
    lines.push(``);
  }

  lines.push(
    `Advisory counts are all time — a mature project carries more than a young one, and a`,
    `count is not a warning on its own. Untracked dependencies are not being judged; the`,
    `watchlist is curated and partial.`,
  );

  summary(lines);
  await comment(
    [
      ...lines,
      ``,
      `<sub>Readings taken by [Sighttrue](${endpoint}), every four hours. This comment is`,
      `rewritten in place on each push rather than added to.</sub>`,
    ].join('\n'),
  );

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

// Only when run as a command. Guarded so the tests can import the parsing
// helpers without the module firing a network run on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { names, pullRequestNumber, MARKER };
