/**
 * Record a deployment outcome in the committed ledger.
 *
 *   node scripts/record-deploy.ts --hash=<sha256> --deployed=true|false
 *
 * Runs after the Cloudflare step. Kept separate from the build so a failed
 * deployment cannot mark its bundle as shipped — the gate stays open and the
 * next run retries rather than skipping something that never went out.
 */

import { recordDeploy } from '../src/build.ts';

function flag(name: string): string {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (raw === undefined) throw new Error(`--${name} is required`);
  return raw.slice(name.length + 3);
}

const hash = flag('hash');
const deployed = flag('deployed') === 'true';

const meta = recordDeploy(hash, deployed);

console.log(
  deployed
    ? `deployed, bundle hash now ${String(meta.bundleHash).slice(0, 16)}`
    : 'deployment skipped, bundle hash unchanged',
);
