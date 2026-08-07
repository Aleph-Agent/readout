/**
 * Validate `server.json` against the registry's published schema.
 *
 *   node scripts/check-mcp-manifest.mjs
 *
 * Written after a publish was refused for a description twenty times over the
 * limit, having been "validated" by hand first. The hand check read
 * `schema.properties` and found nothing, which looked like a clean pass — the
 * real definition is behind `$ref` in `definitions`, and every constraint was
 * sitting there unread.
 *
 * A checker that looks in the wrong place reports success. That is the same
 * failure as grepping a bundle for a string to prove it parses, twice in one
 * day, so this follows the `$ref` rather than assuming where the rules live.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const MANIFEST = fileURLToPath(new URL('../server.json', import.meta.url));

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

const response = await fetch(SCHEMA_URL);
if (!response.ok) throw new Error(`${response.status} fetching the schema`);
const schema = await response.json();

/** Follow the root `$ref`, which is where every real constraint lives. */
function resolve(node) {
  if (node?.$ref === undefined) return node;
  const path = node.$ref.replace(/^#\//, '').split('/');
  return path.reduce((current, key) => current?.[key], schema);
}

const root = resolve(schema);
if (root?.properties === undefined) {
  throw new Error('could not resolve the schema root; the shape has changed');
}

const problems = [];

for (const key of root.required ?? []) {
  if (manifest[key] === undefined) problems.push(`missing required field: ${key}`);
}

for (const [key, value] of Object.entries(manifest)) {
  if (key === '$schema') continue;

  const rule = resolve(root.properties[key]);
  if (rule === undefined) {
    problems.push(`unknown field: ${key}`);
    continue;
  }

  if (typeof value === 'string') {
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      problems.push(`${key} is ${value.length} characters, over the ${rule.maxLength} limit`);
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      problems.push(`${key} is ${value.length} characters, under the ${rule.minLength} minimum`);
    }
    if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)) {
      problems.push(`${key} does not match ${rule.pattern}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\nserver.json: ${problems.length} problem(s).`);
  process.exit(1);
}

console.log(`server.json is valid against ${SCHEMA_URL.split('/').slice(-2).join('/')}.`);
console.log(`  name        ${manifest.name}`);
console.log(`  description ${manifest.description.length} chars`);
console.log(`  remote      ${manifest.remotes?.[0]?.url ?? '(none)'}`);
