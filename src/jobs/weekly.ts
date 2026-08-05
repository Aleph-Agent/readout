import { collectLineage } from '../collectors/lineage.ts';
import { createHuggingFaceClient, type HuggingFaceClient } from '../lib/huggingface.ts';
import {
  appendEvents,
  readAllEvents,
  readLineageRoots,
  readMeta,
  writeLineageRoots,
  writeMeta,
} from '../lib/ledger.ts';
import { utcDate, utcMonth } from '../lib/paths.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * The weekly job: model descent.
 *
 * Weekly because descent moves at the speed of people training models, and
 * because a daily read would report noise as news. The cadence table has had a
 * weekly row since the beginning; this is the job that fills it.
 *
 * Costs nothing against the GitHub budget — it talks to Hugging Face only.
 */

export interface WeeklyOptions {
  now?: Date;
  client?: HuggingFaceClient;
  token?: string;
}

export async function runWeekly(options: WeeklyOptions = {}): Promise<MetaRecord> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const today = utcDate(now);
  const month = utcMonth(now);

  const client =
    options.client ??
    createHuggingFaceClient({ token: options.token ?? process.env['HF_TOKEN'] ?? '' });

  const roots = readLineageRoots();
  const seen = new Set(readAllEvents().map((event) => event.id));

  const result = await collectLineage(client, roots, { now: nowIso, today, seen });

  writeLineageRoots(result.roots);
  if (result.events.length > 0) appendEvents(month, result.events);

  const previous = readMeta();
  const meta: MetaRecord = {
    ...previous,
    lastRunAt: nowIso,
    lastSuccessfulRunAt: result.errors.length > 0 ? previous.lastSuccessfulRunAt : nowIso,
    job: 'weekly',
    partial: result.errors.length > 0,
    reposChecked: roots.filter((root) => root.active).length,
    eventsDetected: result.events.length,
    collectorsErrored: result.errors,
  };

  writeMeta(meta);
  return meta;
}
