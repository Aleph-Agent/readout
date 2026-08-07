import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error plain ESM, deliberately untyped — it runs on a bare runner.
import { names, pullRequestNumber, MARKER } from '../action/check.mjs';

/**
 * The action is the only distribution channel here that reaches somebody
 * without them visiting a website, and the only code in the project that runs
 * inside a stranger's pipeline. Two rules follow from that, and both are
 * tested end to end against a stub rather than asserted in a comment:
 *
 * it must never fail a build for a reason that is not a finding, and it must
 * never turn a busy branch into a wall of near-identical comments.
 */

const CHECK = fileURLToPath(new URL('../action/check.mjs', import.meta.url));

interface Posted {
  method: string;
  path: string;
  body: unknown;
}

let server: Server;
let origin: string;
let comments: { id: number; body: string }[] = [];
let calls: Posted[] = [];
/** Set by a test to make the readings endpoint fail. */
let readingsFail = false;

const INDEX = {
  benchmark: { repositories: 388, medianScorecard: 5.2, scored: 300 },
  packages: {
    'npm:left-pad': {
      repo: 'stevemao/left-pad',
      installs: 1000,
      scorecard: 3.1,
      advisories: 0,
      license: 'WTFPL',
      archived: true,
      pushedAt: '2018-01-01T00:00:00Z',
    },
    'npm:hashicorp-sdk': {
      repo: 'hashicorp/sdk',
      installs: 5000,
      scorecard: 7.0,
      advisories: 0,
      license: 'BUSL-1.1',
      archived: false,
      pushedAt: '2026-08-01T00:00:00Z',
    },
    'npm:react': {
      repo: 'facebook/react',
      installs: 900,
      scorecard: 7.1,
      advisories: 0,
      license: 'MIT',
      archived: false,
      pushedAt: '2026-08-01T00:00:00Z',
    },
  },
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? '';
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = raw === '' ? undefined : JSON.parse(raw);
      calls.push({ method: request.method ?? '', path: url, body });

      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (url.startsWith('/data/stack-index.json')) {
        if (readingsFail) return send(503, { error: 'down' });
        return send(200, INDEX);
      }

      // OSV, answering "no advisories" for everything asked about.
      if (url.startsWith('/v1/querybatch')) {
        const queries = (body as { queries: unknown[] }).queries;
        return send(200, { results: queries.map(() => ({ vulns: [] })) });
      }

      if (request.method === 'GET' && /\/issues\/7\/comments/.test(url)) {
        return send(200, comments);
      }
      if (request.method === 'POST' && /\/issues\/7\/comments/.test(url)) {
        const created = { id: 101, body: (body as { body: string }).body };
        comments.push(created);
        return send(201, created);
      }
      if (request.method === 'PATCH' && /\/issues\/comments\/101/.test(url)) {
        const existing = comments.find((entry) => entry.id === 101);
        if (existing) existing.body = (body as { body: string }).body;
        return send(200, existing);
      }

      send(404, { error: 'no route' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterAll(() => {
  server.close();
});

interface RunResult {
  code: number;
  out: string;
}

function run(env: Record<string, string>, manifest: string): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'readout-action-'));
  const path = join(dir, 'package.json');
  writeFileSync(path, manifest, 'utf8');

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHECK], {
      env: {
        ...process.env,
        READOUT_MANIFEST: path,
        READOUT_ENDPOINT: origin,
        // Pointed at the stub so the suite never reaches the real OSV.
        READOUT_OSV: origin,
        READOUT_FAIL_ON: '',
        GITHUB_API_URL: origin,
        GITHUB_OUTPUT: '',
        GITHUB_STEP_SUMMARY: '',
        GITHUB_REF: 'refs/pull/7/merge',
        GITHUB_REPOSITORY: 'someone/theirs',
        GITHUB_EVENT_PATH: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? 0, out }));
  });
}

const MANIFEST = JSON.stringify({
  dependencies: { 'left-pad': '^1.0.0', 'hashicorp-sdk': '^2.0.0', react: '^19.0.0' },
});

describe('manifest parsing', () => {
  it('reads the three dependency groups from a package.json', () => {
    const text = JSON.stringify({
      dependencies: { react: '^19' },
      devDependencies: { vitest: '^4' },
      peerDependencies: { typescript: '^5' },
    });

    expect(names(text, 'npm').sort()).toEqual(['react', 'typescript', 'vitest']);
  });

  it('survives a requirements.txt with comments, extras and pins', () => {
    const text = ['# comment', 'Django>=5.0  # inline', 'requests[socks]==2.31.0', '', '-r other.txt'].join(
      '\n',
    );

    // Folded to lower case, because PyPI treats the name case-insensitively and
    // counting `PyYAML` and `pyyaml` separately has already happened once here.
    expect(names(text, 'pypi').sort()).toEqual(['django', 'requests']);
  });

  it('reads a Cargo.toml without tripping on its section headers', () => {
    const text = ['[dependencies]', 'serde = "1.0"', 'tokio = { version = "1" }', '[dev-dependencies]', 'proptest = "1"'].join(
      '\n',
    );

    expect(names(text, 'crates').sort()).toEqual(['proptest', 'serde', 'tokio']);
  });

  it('returns nothing rather than throwing on a manifest it cannot parse', () => {
    expect(names('{ not json', 'npm')).toEqual([]);
  });
});

describe('finding the pull request', () => {
  it('reads the number from the event payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readout-event-'));
    const path = join(dir, 'event.json');
    writeFileSync(path, JSON.stringify({ pull_request: { number: 42 } }), 'utf8');

    process.env.GITHUB_EVENT_PATH = path;
    expect(pullRequestNumber()).toBe(42);
    delete process.env.GITHUB_EVENT_PATH;
  });

  it('falls back to the ref when there is no payload', () => {
    delete process.env.GITHUB_EVENT_PATH;
    process.env.GITHUB_REF = 'refs/pull/9/merge';
    expect(pullRequestNumber()).toBe(9);
  });

  it('reports no pull request on a push', () => {
    delete process.env.GITHUB_EVENT_PATH;
    process.env.GITHUB_REF = 'refs/heads/main';
    expect(pullRequestNumber()).toBe(null);
  });
});

describe('the pull request comment', () => {
  it('posts once, then rewrites the same comment on the next push', async () => {
    comments = [];
    calls = [];

    const first = await run({ READOUT_TOKEN: 'stub' }, MANIFEST);
    expect(first.code).toBe(0);
    expect(comments).toHaveLength(1);

    const body = comments[0]?.body ?? '';
    expect(body).toContain(MARKER);
    expect(body).toContain('left-pad');
    expect(body).toContain('archived');
    expect(body).toContain('BUSL-1.1');
    // A tracked package links to its page; the table is the finding, and the
    // link is what makes it checkable.
    expect(body).toContain('/repo/stevemao/left-pad');
    // Nothing wrong with react, so it is not in the table.
    expect(body).not.toContain('| [`react`]');

    const second = await run({ READOUT_TOKEN: 'stub' }, MANIFEST);
    expect(second.code).toBe(0);
    // Still one. A comment per push is how a useful check gets muted.
    expect(comments).toHaveLength(1);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(true);
  });

  it('says so in the comment when there is nothing to say', async () => {
    comments = [];
    const result = await run(
      { READOUT_TOKEN: 'stub' },
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );

    expect(result.code).toBe(0);
    // Rewritten rather than deleted. A warning that vanishes leaves a reviewer
    // unable to tell "fixed" from "the check stopped running".
    expect(comments[0]?.body).toContain('Nothing to report');
  });

  it('posts nothing when the run is not a pull request', async () => {
    comments = [];
    const result = await run({ READOUT_TOKEN: 'stub', GITHUB_REF: 'refs/heads/main' }, MANIFEST);

    expect(result.code).toBe(0);
    expect(comments).toEqual([]);
  });

  it('posts nothing when commenting is switched off', async () => {
    comments = [];
    const result = await run({ READOUT_TOKEN: 'stub', READOUT_COMMENT: 'false' }, MANIFEST);

    expect(result.code).toBe(0);
    expect(comments).toEqual([]);
  });

  it('passes the build when the token cannot comment', async () => {
    // What a pull request from a fork gets: a read-only token. Normal, not a
    // fault, and never a reason to fail somebody's pipeline.
    comments = [];
    const result = await run({ READOUT_TOKEN: '' }, MANIFEST);

    expect(result.code).toBe(0);
    expect(comments).toEqual([]);
  });

  it('leaves a real finding standing when the readings go down', async () => {
    comments = [{ id: 101, body: `${MARKER}\n### Readout\n\nleft-pad is archived.` }];
    readingsFail = true;

    const result = await run({ READOUT_TOKEN: 'stub' }, MANIFEST);
    readingsFail = false;

    expect(result.code).toBe(0);
    expect(result.out).toContain('Readings unavailable');
    // Overwriting here would retract a true finding because of an unrelated
    // outage, which is worse than saying nothing.
    expect(comments[0]?.body).toContain('left-pad is archived');
  });
});

describe('failing the build', () => {
  it('fails only on the conditions it was asked to fail on', async () => {
    comments = [];
    const strict = await run({ READOUT_TOKEN: 'stub', READOUT_FAIL_ON: 'archived' }, MANIFEST);
    expect(strict.code).toBe(1);

    comments = [];
    const lenient = await run({ READOUT_TOKEN: 'stub', READOUT_FAIL_ON: 'advisories' }, MANIFEST);
    expect(lenient.code).toBe(0);
  });

  it('passes when the manifest is missing rather than blaming the build', async () => {
    const result = await run(
      { READOUT_TOKEN: 'stub', READOUT_MANIFEST: 'nowhere/package.json' },
      MANIFEST,
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain('No manifest');
  });
});
