import type { ForkSample } from '../types/window.ts';

/**
 * The rolling observation window.
 *
 * Pure sample bookkeeping: append when something changed, prune to the minimum
 * that still supports a 24-hour lookback, and answer "what was this repository
 * at, a day ago?".
 */

const MS_PER_HOUR = 3_600_000;

/** Matches `SpikeThresholds.minWindowHours`. */
const DEFAULT_WINDOW_HOURS = 24;

/**
 * Drop everything older than the anchor — the newest sample at or before the
 * window boundary. Anything older can never be read again, and keeping it would
 * grow the file without bound.
 *
 * When no sample is old enough yet, everything is kept: the window is still
 * filling and discarding the oldest reading would push that further away.
 */
export function pruneSamples(
  samples: readonly ForkSample[],
  nowMs: number,
  windowHours: number = DEFAULT_WINDOW_HOURS,
): ForkSample[] {
  const boundary = nowMs - windowHours * MS_PER_HOUR;

  let anchor = -1;
  for (let i = 0; i < samples.length; i += 1) {
    if (Date.parse((samples[i] as ForkSample).at) <= boundary) anchor = i;
    else break;
  }

  return anchor <= 0 ? [...samples] : samples.slice(anchor);
}

/**
 * Fold a new reading into a repository's samples.
 *
 * Appends when the fork count changed — the ordinary case — and also when the
 * newest sample has aged past the window. That second condition matters: a
 * repository dormant for a week then spiking would otherwise be measured
 * against a week-old anchor, diluting a real spike across seven days of
 * baseline and hiding it.
 */
export function recordSample(
  samples: readonly ForkSample[],
  at: string,
  forks: number,
  windowHours: number = DEFAULT_WINDOW_HOURS,
): ForkSample[] {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error(`recordSample: "${at}" is not an ISO timestamp`);

  const last = samples.at(-1);
  const changed = last === undefined || last.forks !== forks;
  const stale = last !== undefined && atMs - Date.parse(last.at) >= windowHours * MS_PER_HOUR;

  const next = changed || stale ? [...samples, { at, forks }] : [...samples];
  return pruneSamples(next, atMs, windowHours);
}

/**
 * The far edge of the window: the newest sample at least `windowHours` old.
 * Null while the window is still filling, which classifies as `forming` rather
 * than being papered over with the oldest available reading.
 */
export function windowAnchor(
  samples: readonly ForkSample[],
  nowMs: number,
  windowHours: number = DEFAULT_WINDOW_HOURS,
): ForkSample | null {
  const boundary = nowMs - windowHours * MS_PER_HOUR;

  let anchor: ForkSample | null = null;
  for (const sample of samples) {
    if (Date.parse(sample.at) <= boundary) anchor = sample;
    else break;
  }

  return anchor;
}
