/**
 * Weekly entry point: model descent.
 *
 *   node scripts/weekly.ts
 *
 * Talks to Hugging Face only, so it costs nothing against the GitHub budget and
 * needs no token — public model metadata is unauthenticated.
 */

import { runWeekly } from '../src/jobs/weekly.ts';

const meta = await runWeekly();

console.log(
  [
    `job              ${meta.job}`,
    `roots traced     ${meta.reposChecked}`,
    `findings         ${meta.eventsDetected}`,
    `partial          ${meta.partial}`,
  ].join('\n'),
);

for (const error of meta.collectorsErrored) console.warn(`warn: ${error}`);
