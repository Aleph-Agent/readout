import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SITE_SCRIPT } from '../src/site/render.ts';

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
