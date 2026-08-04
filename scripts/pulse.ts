/**
 * Pulse entry point.
 *
 *   node scripts/pulse.ts
 *   node scripts/pulse.ts --limit=20      # dry run against a slice
 *
 * Exits 0 even on a partial run. Stopping early on budget is a designed
 * outcome, and failing the workflow would suppress the commit step that keeps
 * scheduled runs from being auto-disabled after 60 days of inactivity.
 */

import { runPulse } from '../src/jobs/pulse.ts';

function numericFlag(name: string): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (raw === undefined) return undefined;

  const value = Number.parseInt(raw.slice(name.length + 3), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} expects a positive integer`);
  }
  return value;
}

const token = process.env['GITHUB_PAT'] ?? '';
if (token === '') {
  console.error(
    'GITHUB_PAT is not set. A fine-grained token with public-repository read\n' +
      'access is required; unauthenticated calls are capped at 60/hour and\n' +
      'exhaust in seconds.',
  );
  process.exit(1);
}

const limit = numericFlag('limit');
const meta = await runPulse(limit === undefined ? { token } : { token, limit });

console.log(
  [
    `job                  ${meta.job}`,
    `repos checked        ${meta.reposChecked}`,
    `unchanged (304)      ${meta.requestsUnchanged}`,
    `requests consumed    ${meta.requestsConsumed}`,
    `rate limit remaining ${meta.rateLimitRemaining ?? 'unknown'}`,
    `events detected      ${meta.eventsDetected}`,
    `partial              ${meta.partial}`,
  ].join('\n'),
);

for (const error of meta.collectorsErrored) console.warn(`warn: ${error}`);
