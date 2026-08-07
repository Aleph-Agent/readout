import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SITE_SCRIPT } from '../src/site/render.ts';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

/**
 * Does the site's JavaScript parse.
 *
 * It did not, for a while, and everything downstream of that failed silently:
 * the theme switch never appeared, the relative timestamps never resolved, the
 * answer box, the comparison tool and the stack checker were all inert. The
 * page still rendered, still returned 200, and still contained every string
 * anybody thought to grep for.
 *
 * That is what made it survive. The bundle was verified by searching it for
 * `data-theme-switch` and finding it — a check that passes just as happily on a
 * file the browser refuses to execute. Presence is not validity, and only one
 * of the two is worth asserting.
 *
 * The cause was a newline that should have been an escape sequence and became a
 * literal line break inside a string. The script is assembled from template
 * literals in TypeScript, so anything that has to survive two levels of
 * escaping is a place this can happen again.
 *
 * Parsing the result is the only check that does not care how it got broken. A
 * hand-rolled scan for unbalanced quotes was written here first and removed:
 * to be right it would have to understand template literals, regex literals
 * and apostrophes in comments, and being wrong about any of those is how the
 * original defect got through.
 */

describe('the site script', () => {
  it('parses', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'readout-script-')), 'site.js');
    writeFileSync(path, SITE_SCRIPT, 'utf8');

    // The real parser rather than a regex. A hand-rolled check would have to
    // know about template literals, regex literals and strings to be right, and
    // being wrong about any of them is how this got through the first time.
    expect(() => execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })).not.toThrow();
  });

  it('puts the theme switch first, so a later failure cannot hide it', () => {
    // Every other block is a tool somebody has to go looking for. This one is
    // the difference between the page appearing to have changed and appearing
    // not to have.
    expect(SITE_SCRIPT.indexOf('data-theme-switch')).toBeLessThan(
      SITE_SCRIPT.indexOf('stack-form'),
    );
  });
});

/**
 * Sign-in has to be findable, and it has to speak when it breaks.
 *
 * Both of these are the same bug wearing two faces. Sign-in lived halfway down
 * one page, so a reader had to already know the feature existed to find the way
 * in — and when the session failed, the page redrew the identical sign-in
 * button with no explanation, so somebody who had just authorised on GitHub had
 * no way to tell whether they had done something wrong or the site had.
 */
describe('sign-in is reachable and never silent', () => {
  const pages = readdirSync(DIST, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name));

  it('puts the control in the chrome of every page', () => {
    // Every page, not only /account. The bar is where a reader looks for
    // whether they are signed in, and it is on all 1,500 of them.
    expect(pages.length).toBeGreaterThan(100);
    for (const page of pages) {
      expect(readFileSync(page, 'utf8'), page).toContain('data-account-slot');
    }
  });

  it('gives the stack page somewhere to report a failure', () => {
    // On /stack, not a page of its own. Two pages both titled "Your stack" was
    // the confusion the navigation rewrite removed.
    const account = readFileSync(join(DIST, 'stack.html'), 'utf8');

    expect(account).toContain('id="account-gate-note"');
    // Hidden until there is something to say. A permanently visible warning is
    // a warning nobody reads.
    expect(account).toMatch(/id="account-gate-note"[^>]*hidden/);
  });

  it('writes the reason into the page rather than discarding it', () => {
    // The empty catch was the original defect: a rejected cookie, a blocked
    // request and a genuine first visit all produced the same page.
    expect(SITE_SCRIPT).toContain('account-gate-note');
    expect(SITE_SCRIPT).toContain('Sign-in unavailable');
    expect(SITE_SCRIPT).toContain('did not keep the ');
  });

  it('asks who is signed in exactly once per page load', () => {
    // The chrome control starts the request and the watchlist waits on the same
    // promise. Two fetches of the same no-store endpoint on one page load is a
    // request nobody needed.
    const asks = SITE_SCRIPT.split("fetch('/api/auth/me'").length - 1;
    expect(asks).toBe(1);
  });
});
