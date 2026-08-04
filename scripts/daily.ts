/**
 * Daily entry point: canonical snapshot, then spike classification.
 *
 *   node scripts/daily.ts
 *
 * Makes no network calls. It reads what the pulses already collected, which is
 * why it can run immediately after one without spending any budget.
 */

import { runDaily } from '../src/jobs/daily.ts';

const meta = await runDaily();

console.log(
  [
    `job                  ${meta.job}`,
    `repos snapshotted    ${meta.reposChecked}`,
    `spike events         ${meta.eventsDetected}`,
    `partial              ${meta.partial}`,
  ].join('\n'),
);

for (const error of meta.collectorsErrored) console.warn(`warn: ${error}`);
