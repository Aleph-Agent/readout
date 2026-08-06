import type { EventMetrics, EventRecord } from '../types/events.ts';

/**
 * Post-generation enforcement of the anchoring rule.
 *
 * The prompt asks the model not to invent numbers. This checks whether it did,
 * because a prompt is a request and a public claim needs a guarantee. Every
 * numeric token in the generated text must appear in the source record; on any
 * mismatch the summary is discarded in favour of a templated sentence.
 *
 * A templated sentence that is certainly true beats a fluent one that might
 * not be.
 */

/** Matches integers, decimals, and comma-grouped thousands. */
const NUMBER_PATTERN = /\d[\d,]*(?:\.\d+)?/g;

const MAX_SENTENCES = 2;

export function extractNumbers(text: string): string[] {
  return [...text.matchAll(NUMBER_PATTERN)].map((match) => match[0]);
}

function normalise(token: string): string {
  const stripped = token.replace(/,/g, '');
  // "45.0" and "45" are the same claim; trailing zeros should not fail.
  return stripped.includes('.') ? stripped.replace(/\.?0+$/, '') : stripped;
}

/**
 * Every numeric string the model is permitted to write.
 *
 * Rounding is allowed in one direction only: if the record holds 45.3 then
 * "45" is honest, but "approximately 50" discards precision that was available
 * and is not in this set.
 */
export function allowedNumbers(metrics: EventMetrics): Set<string> {
  const allowed = new Set<string>();
  const add = (token: string): void => {
    allowed.add(normalise(token));
  };

  for (const value of Object.values(metrics)) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      add(String(value));
      add(String(Math.round(value)));
      add(String(Math.trunc(value)));
      add(value.toFixed(1));
    } else if (typeof value === 'string') {
      // Versions and timestamps carry numbers the model legitimately quotes:
      // "v1.2.3" licenses 1, 2, and 3; "2026-08-04" licenses the date parts.
      for (const token of extractNumbers(value)) add(token);
    }
  }

  return allowed;
}

export type Validation =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

export function validateSummary(text: string, metrics: EventMetrics): Validation {
  const trimmed = text.trim();

  if (trimmed === '') return { ok: false, reason: 'empty response' };
  if (trimmed.includes('!')) return { ok: false, reason: 'exclamation mark' };

  const sentences = trimmed.split(/(?<=[.?])\s+/).filter((part) => part.trim() !== '');
  if (sentences.length > MAX_SENTENCES) {
    return { ok: false, reason: `${sentences.length} sentences, limit is ${MAX_SENTENCES}` };
  }

  const allowed = allowedNumbers(metrics);
  for (const token of extractNumbers(trimmed)) {
    if (!allowed.has(normalise(token))) {
      return { ok: false, reason: `number ${token} does not appear in the record` };
    }
  }

  return { ok: true, summary: trimmed };
}

function metricNumber(metrics: EventMetrics, key: string): number | null {
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metricString(metrics: EventMetrics, key: string): string | null {
  const value = metrics[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The fallback: a sentence assembled only from values already in the record.
 *
 * Used when the model invents something, and available as the permanent answer
 * for signals that never warrant prose. Returns null when even a template would
 * be asserting more than the record supports.
 */
export function templatedSentence(event: EventRecord): string | null {
  const { metrics } = event;

  if (event.kind === 'release') {
    const tag = metricString(metrics, 'tag');
    if (tag === null) return null;

    const previous = metricString(metrics, 'previousTag');
    const published = metricString(metrics, 'publishedAt');
    const when = published === null ? '' : ` on ${published.slice(0, 10)}`;

    return previous === null
      ? `${event.repo} published ${tag}${when}.`
      : `${event.repo} published ${tag}${when}, following ${previous}.`;
  }

  if (event.kind === 'licence') {
    const from = metricString(metrics, 'from');
    const to = metricString(metrics, 'to');
    if (from === null || to === null) return null;

    // States the whole fact. No model is involved and none could add anything
    // except the chance of being wrong about the one signal here that cannot
    // otherwise be wrong.
    return `${event.repo} changed its licence from ${from} to ${to}.`;
  }

  if (event.kind === 'archived') {
    return `${event.repo} was archived and is now read-only.`;
  }

  if (event.kind === 'model-price') {
    const from = metricNumber(metrics, 'from');
    const to = metricNumber(metrics, 'to');
    if (from === null || to === null) return null;

    // States the direction and both ends. No model is involved and none could
    // add anything here except a chance of being wrong about a price.
    const direction = to > from ? 'rose' : 'fell';
    return `${event.repo} ${direction} from $${from} to $${to} per million prompt tokens.`;
  }

  if (event.kind === 'model-withdrawn') {
    const last = metricString(metrics, 'lastSeen');
    if (last === null) return null;
    return `${event.repo} is no longer offered. Last seen ${last}.`;
  }

  if (event.kind === 'lineage') {
    const base = metricString(metrics, 'baseModel');
    const added = metricNumber(metrics, 'newDescendants');
    const uploaders = metricNumber(metrics, 'uploaders');
    if (base === null || added === null || uploaders === null) return null;

    // "declared" carries the whole claim. The base-model relation is written by
    // whoever uploaded the model; it is what they say they built on, and the
    // sentence must not quietly upgrade that into what they did build on.
    return `${added} models from ${uploaders} accounts declared ${base} as their base model this week.`;
  }

  if (event.kind === 'fork-outlier') {
    const added = metricNumber(metrics, 'forksAdded');
    const hours = metricNumber(metrics, 'observationHours');
    const median = metricNumber(metrics, 'categoryMedian');
    const peers = metricNumber(metrics, 'peers');
    const category = metricString(metrics, 'category');
    if (added === null || hours === null || median === null || peers === null || category === null) {
      return null;
    }

    // Names the comparison group and its size. A multiple of a median means
    // nothing without knowing how many things were in the sample.
    return `${event.repo} added ${added} forks over ${hours} hours; the median of the ${peers} ${category} repositories measured was ${median}.`;
  }

  if (event.kind === 'fork-spike') {
    const added = metricNumber(metrics, 'forksAdded');
    const hours = metricNumber(metrics, 'observationHours');
    const multiplier = metricNumber(metrics, 'multiplier');
    const baselineDays = metricNumber(metrics, 'baselineDays');
    if (added === null || hours === null || multiplier === null || baselineDays === null) {
      return null;
    }

    // Above the cap the figure is bounded rather than stated, because precision
    // at that magnitude implies confidence the data does not support.
    const rate =
      metricString(metrics, 'multiplierCapped') === 'yes'
        ? `more than ${multiplier}×`
        : `${multiplier}×`;

    return `Forks rose by ${added} over ${hours} hours, ${rate} this repository's ${baselineDays}-day baseline.`;
  }

  return null;
}
