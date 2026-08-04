import { createLlmClient, type LlmClient } from '../lib/llm.ts';
import {
  readAllEvents,
  readMeta,
  readSummarised,
  writeMeta,
  writeSummaries,
} from '../lib/ledger.ts';
import { buildUserContent, isRefusal, SYSTEM_INSTRUCTION } from '../lib/prompt.ts';
import { templatedSentence, validateSummary } from '../lib/validate.ts';
import type { EventRecord } from '../types/events.ts';
import type { MetaRecord } from '../types/meta.ts';
import type { SummaryRecord } from '../types/summaries.ts';

/**
 * Summarisation pass.
 *
 * Only events already marked `pending` by their collector are considered —
 * clearing the significance threshold is the collector's decision, not this
 * job's. Everything else displays raw numbers with no prose, which is a normal
 * and frequent outcome.
 *
 * An event summarised once is never reconsidered. Without that, the 4-hourly
 * cadence would multiply LLM usage sixfold and break the free-tier budget
 * inside a day.
 */

export interface SummariseOptions {
  apiKey?: string;
  /** Pre-built client, for tests that never reach the network. */
  client?: LlmClient;
  now?: Date;
  /** Cap the pass. Useful when validating prompt wording against real events. */
  limit?: number;
}

export interface SummariseResult {
  meta: MetaRecord;
  attempted: number;
  fromModel: number;
  fromTemplate: number;
  insufficient: number;
  failed: string[];
}

export async function runSummarise(options: SummariseOptions = {}): Promise<SummariseResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  const client =
    options.client ??
    createLlmClient({ apiKey: options.apiKey ?? process.env['GROQ_API_KEY'] ?? '' });

  const done = readSummarised();
  const queue: EventRecord[] = readAllEvents().filter(
    (event) => event.summaryState === 'pending' && !done.has(event.id),
  );

  const pending = options.limit === undefined ? queue : queue.slice(0, options.limit);

  const failed: string[] = [];
  let fromModel = 0;
  let fromTemplate = 0;
  let insufficient = 0;

  for (const event of pending) {
    let record: SummaryRecord;

    try {
      const raw = await client.complete(SYSTEM_INSTRUCTION, buildUserContent(event));

      if (isRefusal(raw)) {
        // A correct outcome. The event still renders, with its numbers and no
        // interpretation attached to them.
        insufficient += 1;
        record = {
          eventId: event.id,
          state: 'skipped',
          text: null,
          source: 'none',
          insufficient: true,
          model: client.model,
          generatedAt: nowIso,
        };
      } else {
        const validation = validateSummary(raw, event.metrics);

        if (validation.ok) {
          fromModel += 1;
          record = {
            eventId: event.id,
            state: 'summarised',
            text: validation.summary,
            source: 'model',
            insufficient: false,
            model: client.model,
            generatedAt: nowIso,
          };
        } else {
          // The model introduced something the record does not support. Discard
          // it entirely rather than trying to repair it.
          const template = templatedSentence(event);
          if (template === null) {
            record = {
              eventId: event.id,
              state: 'skipped',
              text: null,
              source: 'none',
              insufficient: false,
              model: null,
              generatedAt: nowIso,
            };
          } else {
            fromTemplate += 1;
            record = {
              eventId: event.id,
              state: 'summarised',
              text: template,
              source: 'template',
              insufficient: false,
              model: null,
              generatedAt: nowIso,
            };
          }
        }
      }
    } catch (error) {
      // Record nothing: leaving the event pending means the next run retries,
      // which is the right behaviour for a transport failure.
      failed.push(`${event.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    done.set(event.id, record);
  }

  const all = [...done.values()];
  writeSummaries(all);

  const attempts = all.length;
  const refusals = all.filter((row) => row.insufficient).length;

  const previous = readMeta();
  const meta: MetaRecord = {
    ...previous,
    summariesGenerated: all.filter((row) => row.state === 'summarised').length,
    // Above roughly 0.25 the significance thresholds are too loose. The fix is
    // to tighten them, not to loosen the prompt.
    insufficientRate: attempts === 0 ? null : refusals / attempts,
    collectorsErrored: [...previous.collectorsErrored, ...failed],
    partial: previous.partial || failed.length > 0,
  };

  writeMeta(meta);

  return {
    meta,
    attempted: pending.length,
    fromModel,
    fromTemplate,
    insufficient,
    failed,
  };
}
