/**
 * One-time bootstrap for `data/lineage-roots.jsonl`.
 *
 *   node scripts/seed-lineage-roots.ts
 *   node scripts/seed-lineage-roots.ts --force
 *
 * Curated, and for the same reason the repository watchlist is: which models
 * matter enough to trace descent from is an editorial claim. Ranking by
 * downloads would surface whatever was uploaded most, which is not the same as
 * what people build on.
 *
 * Each root is verified to exist before being written. `repo` links it to the
 * watchlist entry it belongs to, so a finding lands on a profile page a reader
 * can already reach.
 */

import { existsSync } from 'node:fs';

import { writeLineageRoots } from '../src/lib/ledger.ts';
import { LINEAGE_ROOTS_PATH } from '../src/lib/paths.ts';
import type { LineageRoot } from '../src/types/lineage.ts';

const ADDED = new Date().toISOString().slice(0, 10);

/** model on Hugging Face, and the watchlist repository it comes from. */
const ROOTS: readonly [string, string | null][] = [
  ['meta-llama/Llama-3.1-8B', 'meta-llama/llama3'],
  ['meta-llama/Llama-3.1-70B', 'meta-llama/llama3'],
  ['mistralai/Mistral-7B-v0.3', 'mistralai/mistral-inference'],
  ['Qwen/Qwen2.5-7B', 'QwenLM/Qwen'],
  ['Qwen/Qwen2.5-32B', 'QwenLM/Qwen'],
  ['google/gemma-2-9b', null],
  ['deepseek-ai/DeepSeek-R1', null],
  ['microsoft/phi-4', null],
  ['openai/whisper-large-v3', 'openai/whisper'],
  ['black-forest-labs/FLUX.1-dev', null],
  ['stabilityai/stable-diffusion-xl-base-1.0', 'Stability-AI/stablediffusion'],
  ['sentence-transformers/all-MiniLM-L6-v2', 'UKPLab/sentence-transformers'],
];

if (existsSync(LINEAGE_ROOTS_PATH) && !process.argv.includes('--force')) {
  console.error(
    'lineage-roots.jsonl already exists. It is the source of truth once seeded —\n' +
      'edit it directly and commit the change with a reason. Pass --force to rebuild.',
  );
  process.exit(1);
}

const verified: LineageRoot[] = [];

for (const [id, repo] of ROOTS) {
  const response = await fetch(`https://huggingface.co/api/models/${id}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    console.warn(`  skipped ${id.padEnd(46)} ${response.status}`);
    continue;
  }

  console.log(`  ok      ${id}`);
  verified.push({ id, repo, added: ADDED, active: true, seenThrough: null, descendants: 0 });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

writeLineageRoots(verified);
console.log(`\nWrote ${verified.length} of ${ROOTS.length} roots to data/lineage-roots.jsonl`);
console.log('First weekly run records a watermark for each and reports nothing.');
