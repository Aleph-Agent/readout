/**
 * Summarisation entry point.
 *
 *   node scripts/summarise.ts
 *   node scripts/summarise.ts --limit=20
 *
 * Exits 0 even when individual calls failed. Those events stay pending and the
 * next run retries them; failing the workflow would suppress the commit step
 * that keeps scheduled runs alive.
 */

import { readMeta, writeMeta } from '../src/lib/ledger.ts';
import { runSummarise } from '../src/jobs/summarise.ts';

function numericFlag(name: string): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw.slice(name.length + 3), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} expects a positive integer`);
  return value;
}

/**
 * The workflow runs this step with continue-on-error, because losing
 * interpretation must never stop measurement from publishing. That makes every
 * failure here invisible by default: green job, no alert, nothing in the ledger.
 *
 * So every exit path records first. An earlier version only wrapped the call
 * itself and returned early on a missing key — which is exactly what happened
 * in production. GROQ_API_KEY was empty, thirteen events sat waiting for prose
 * that never came, and meta.json reported partial: false with no errors.
 */
function recordFailure(message: string): never {
  const previous = readMeta();
  writeMeta({
    ...previous,
    partial: true,
    collectorsErrored: [...previous.collectorsErrored, `summarise: ${message}`],
  });

  console.error(`summarise failed: ${message}`);
  console.error('Recorded in meta.json. Readings still publish, without prose.');
  process.exit(1);
}

const apiKey = process.env['GROQ_API_KEY'] ?? '';
if (apiKey === '') recordFailure('GROQ_API_KEY is not set');

const limit = numericFlag('limit');

let result;
try {
  result = await runSummarise(limit === undefined ? { apiKey } : { apiKey, limit });
} catch (error) {
  recordFailure(error instanceof Error ? error.message : String(error));
}

console.log(
  [
    `attempted            ${result.attempted}`,
    `written by model     ${result.fromModel}`,
    `fell back to template ${result.fromTemplate}`,
    `returned INSUFFICIENT ${result.insufficient}`,
    `cumulative rate      ${result.meta.insufficientRate === null ? 'n/a' : `${(result.meta.insufficientRate * 100).toFixed(1)}%`}`,
  ].join('\n'),
);

if (result.meta.insufficientRate !== null && result.meta.insufficientRate > 0.25) {
  console.warn(
    'warn: INSUFFICIENT rate is above 25%. The significance thresholds are too\n' +
      'loose — tighten what gets marked pending rather than loosening the prompt.',
  );
}

for (const error of result.failed) console.warn(`warn: ${error}`);
