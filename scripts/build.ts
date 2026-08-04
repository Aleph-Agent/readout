/**
 * Build entry point.
 *
 *   node scripts/build.ts
 *
 * Emits dist/data and decides whether a deployment is warranted. When running
 * under Actions it writes `deploy=true|false` to $GITHUB_OUTPUT so the workflow
 * can gate the Cloudflare step on it.
 */

import { appendFileSync } from 'node:fs';

import { runBuild } from '../src/build.ts';

const result = runBuild();

for (const file of result.files) {
  console.log(`  ${file.name.padEnd(28)} ${String(file.bytes).padStart(8)} bytes`);
}

console.log('');
console.log(`bundle hash  ${result.bundleHash.slice(0, 16)}`);
console.log(`total        ${result.totalBytes} bytes across ${result.files.length} files`);
console.log(
  result.deploy
    ? 'deploy       yes — bundles changed'
    : 'deploy       no — identical to the previous run, skipping to protect the build quota',
);

const output = process.env['GITHUB_OUTPUT'];
if (output !== undefined && output !== '') {
  appendFileSync(output, `deploy=${String(result.deploy)}\nhash=${result.bundleHash}\n`, 'utf8');
}
