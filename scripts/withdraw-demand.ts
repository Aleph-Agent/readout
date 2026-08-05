/**
 * Retract demand clusters the detector should never have published.
 *
 *   node scripts/withdraw-demand.ts --dry-run
 *   node scripts/withdraw-demand.ts
 *
 * The first live run produced 141 clusters against a budget of ten, and 140 of
 * them were single words — `failed`, `support`, `add`, `test`. Those are not
 * things anyone asked for, they are English. The detector now requires word
 * pairs and rejects terms that appear across too much of the sample.
 *
 * The bad records cannot be deleted. Events are append-only because the git
 * history of that file is the evidence nothing was quietly changed, and that
 * argument only holds if it also survives the project's own mistakes. So each
 * one is superseded by a retraction, and the published page discloses the count
 * rather than rendering a card per retraction.
 *
 * This is a one-off. Once the ledger is clean it has nothing left to do.
 */

import { appendEvents, readAllEvents } from '../src/lib/ledger.ts';
import { utcMonth } from '../src/lib/paths.ts';
import { clusterDemand, DEFAULT_DEMAND_THRESHOLDS } from '../src/lib/demand.ts';
import type { EventRecord } from '../src/types/events.ts';

const dryRun = process.argv.includes('--dry-run');
const now = new Date();
const nowIso = now.toISOString();

const all = readAllEvents();
const seen = new Set(all.map((event) => event.id));
const superseded = new Set(
  all.map((event) => event.supersedes).filter((id): id is string => id !== null),
);

/** The rules the detector enforces now, applied to what it published then. */
function wouldPublishToday(event: EventRecord): boolean {
  const term = String(event.metrics['term'] ?? '');
  const repos = Number(event.metrics['repositories'] ?? 0);
  const engagement = Number(event.metrics['engagement'] ?? 0);

  if (term.split(' ').length !== 2) return false;
  if (repos > 12) return false;
  if (engagement < DEFAULT_DEMAND_THRESHOLDS.minEngagement) return false;
  // A pair of empty words says as little as one did.
  if (clusterDemand([{ repo: 'x/x', number: 1, title: term, url: '', reactions: 0, comments: 0 }],
      { ...DEFAULT_DEMAND_THRESHOLDS, minRepos: 1, minIssues: 1, minEngagement: 0, maxRepoShare: 1 })
      .length === 0) {
    return false;
  }
  return true;
}

const doomed = all.filter(
  (event) =>
    event.kind === 'demand-cluster' && !superseded.has(event.id) && !wouldPublishToday(event),
);

const retractions: EventRecord[] = doomed.map<EventRecord>((event) => ({
  id: `correction:${event.id}`,
  kind: 'correction' as const,
  repo: event.repo,
  detectedAt: nowIso,
  confidence: 'confirmed',
  summaryState: 'skipped',
  summary: null,
  evidenceUrl: event.evidenceUrl,
  metrics: {
    withdrawn: 'yes',
    retractedTerm: String(event.metrics['term'] ?? ''),
    reason: 'single word rather than a phrase, or too widespread to be a signal',
  },
  supersedes: event.id,
})).filter((event) => !seen.has(event.id));

console.log(`demand clusters on record : ${all.filter((e) => e.kind === 'demand-cluster').length}`);
console.log(`still standing            : ${doomed.length + all.filter((e) => e.kind === 'demand-cluster' && !superseded.has(e.id) && wouldPublishToday(e)).length}`);
console.log(`to retract                : ${retractions.length}`);

if (retractions.length > 0) {
  console.log('');
  for (const event of retractions.slice(0, 5)) {
    console.log(`  ${String(event.metrics['retractedTerm'])}`);
  }
  if (retractions.length > 5) console.log(`  ... and ${retractions.length - 5} more`);
}

if (dryRun) {
  console.log('\ndry run, nothing written');
} else if (retractions.length > 0) {
  appendEvents(utcMonth(now), retractions);
  console.log('\nretractions appended');
}
