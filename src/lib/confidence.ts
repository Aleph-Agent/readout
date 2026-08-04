import type { EventRecord } from '../types/events.ts';

/**
 * When each repository was last classified as spiking.
 *
 * Two-run confirmation reads this, so it must span the whole ledger rather than
 * one month file. Scoped to the current month, a spike detected on the 31st
 * would silently drop back to `detected` on the 1st — the confirmation would
 * reset every month boundary, on exactly the events most worth confirming.
 */
export function lastDetectionByRepo(events: readonly EventRecord[]): Map<string, string> {
  const latest = new Map<string, string>();

  for (const event of events) {
    if (event.kind !== 'fork-spike') continue;
    if (event.confidence !== 'detected' && event.confidence !== 'confirmed') continue;

    const date = event.detectedAt.slice(0, 10);
    const previous = latest.get(event.repo);
    if (previous === undefined || previous < date) latest.set(event.repo, date);
  }

  return latest;
}
