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

import { runSummarise } from '../src/jobs/summarise.ts';

function numericFlag(name: string): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw.slice(name.length + 3), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} expects a positive integer`);
  return value;
}

const apiKey = process.env['GROQ_API_KEY'] ?? '';
if (apiKey === '') {
  console.error('GROQ_API_KEY is not set.');
  process.exit(1);
}

const limit = numericFlag('limit');
const result = await runSummarise(limit === undefined ? { apiKey } : { apiKey, limit });

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
