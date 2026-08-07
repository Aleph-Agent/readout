import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Content-Security-Policy, checked against the files it will actually be
 * served with.
 *
 * Not against the constant it was generated from. That distinction is the one
 * mistake this project keeps making — grepping the source instead of parsing
 * the output, reading the schema instead of following the `$ref`, reading the
 * job instead of running it — and a CSP is the worst place for it, because a
 * policy that is wrong does not fail the build or the request. It silently
 * blocks one script, and the page half-works.
 *
 * So everything here reads `dist`.
 */

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(name: string): string {
  return readFileSync(join(DIST, name), 'utf8');
}

function htmlFiles(directory = DIST, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) htmlFiles(path, found);
    else if (entry.name.endsWith('.html')) found.push(path);
  }
  return found;
}

const headers = read('_headers');
const policy = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? '';

/** One directive out of the policy, as the list of sources it allows. */
function directive(name: string): string[] {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

  return found === undefined ? [] : found.split(/\s+/).slice(1);
}

describe('the inline script is allowed by its own hash', () => {
  // Every page carries a theme boot script that has to run before the first
  // paint. If its hash does not match, the script is blocked, the theme flashes
  // dark-to-light on every page load, and nothing anywhere reports an error.
  const pages = htmlFiles();

  const inline = new Set<string>();
  for (const page of pages) {
    for (const match of readFileSync(page, 'utf8').matchAll(
      /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g,
    )) {
      inline.add(match[1] ?? '');
    }
  }

  it('finds exactly one inline script across the whole site', () => {
    // The policy allows one hash. A second inline script anywhere would be
    // blocked, and this is what says so at build time rather than in a browser
    // nobody is watching.
    expect(inline.size).toBe(1);
  });

  it('matches the hash in the policy, computed from the served bytes', () => {
    const script = [...inline][0] ?? '';
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');

    expect(policy).toContain(`'sha256-${hash}'`);
  });

  it('allows no inline script beyond that hash', () => {
    // The single directive that decides whether an injected string becomes
    // running code. `'unsafe-inline'` here would make the hash decorative.
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
    expect(directive('script-src')).not.toContain("'unsafe-eval'");
  });
});

describe('every origin the site reaches is one the policy allows', () => {
  // The check that survives somebody adding a fetch to a new service six months
  // from now. Without it the policy is correct on the day it is written and
  // quietly wrong afterwards — and the failure is one broken feature, not an
  // error anybody sees.
  const sources = [read('site.js'), ...htmlFiles().slice(0, 40).map((f) => readFileSync(f, 'utf8'))];

  const origins = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/https:\/\/([a-z0-9.-]+)/g)) {
      origins.add(`https://${match[1]}`);
    }
  }

  const allowed = new Set([
    ...directive('script-src'),
    ...directive('connect-src'),
    ...directive('img-src'),
    ...directive('default-src'),
  ]);

  it('allows each of them', () => {
    // Links are not fetches — an href to github.com is navigation, which CSP
    // does not govern. Only origins the page actually loads or calls matter.
    const fetched = [...origins].filter((origin) =>
      /osv\.dev|cloudflareinsights\.com|googleapis|jsdelivr|unpkg|cdn\./.test(origin),
    );

    for (const origin of fetched) {
      expect(allowed.has(origin), `${origin} is fetched but not in the policy`).toBe(true);
    }
  });
});

describe('what the rest of the headers promise', () => {
  it('refuses to be framed, twice', () => {
    // frame-ancestors is what browsers honour; X-Frame-Options is for anything
    // that predates it. A sign-in page that can be framed is a sign-in page
    // somebody can put an invisible layer over.
    expect(policy).toContain("frame-ancestors 'none'");
    expect(headers).toContain('X-Frame-Options: DENY');
  });

  it('will not let an injected base tag repoint the sign-in link', () => {
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'self'");
  });

  it('never lets a shared cache hold an answer about a person', () => {
    const api = headers.slice(headers.indexOf('/api/*'));
    expect(api).toContain('Cache-Control: no-store');
  });

  it('asks for HSTS long enough to be preloadable', () => {
    const hsts = /Strict-Transport-Security: (.+)/.exec(headers)?.[1] ?? '';
    const seconds = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);

    // The preload list requires a year. Below that the header is set and the
    // domain still cannot be preloaded, which is the worst of both.
    expect(seconds).toBeGreaterThanOrEqual(31_536_000);
    expect(hsts).toContain('includeSubDomains');
  });

  it('keeps the published data readable from anywhere', () => {
    // The credibility argument depends on somebody else being able to fetch the
    // bundles and check them. A policy that locked those down would be
    // protecting the one thing that is meant to be taken.
    const data = headers.slice(headers.indexOf('/data/*'));
    expect(data).toContain('Access-Control-Allow-Origin: *');
  });
});
