import type { AssertExhaustive } from './keys.ts';

/**
 * What a model costs, and what it costs today rather than what it cost when
 * somebody last looked.
 *
 * The first reading here with nothing to do with a repository. Prices move
 * weekly across sixty providers, models appear and are quietly withdrawn, and
 * context windows change under a fixed name — and nobody keeps a dated record.
 * Ask what a model cost three months ago and there is no honest answer
 * anywhere, which is how teams end up choosing on a price they remember.
 *
 * That is a measurement problem, which is the one thing this project already
 * knows how to do: read on a schedule, store append-only, publish with a date,
 * and retract rather than delete.
 */

export interface ModelSample {
  /** ISO 8601 UTC of the reading. */
  at: string;
  /** USD per million prompt tokens. */
  prompt: number;
  /** USD per million completion tokens. */
  completion: number;
  context: number;
}

export interface ModelRow {
  /** `provider/model`, as the catalogue spells it. */
  id: string;
  provider: string;
  name: string;
  /** USD per million tokens. Null when the catalogue reports no price. */
  prompt: number | null;
  completion: number | null;
  /** Maximum context in tokens. Null when unreported. */
  context: number | null;
  /** `YYYY-MM-DD` this model was first seen. Not its release date. */
  firstSeen: string;
  /** `YYYY-MM-DD` it was last present in the catalogue. */
  lastSeen: string;
  /**
   * False once a model stops appearing.
   *
   * Kept rather than deleted: a model that vanished is the most useful thing
   * this file records, and dropping the row would erase the only evidence it
   * ever existed at that price.
   */
  available: boolean;
  /** Recent readings, oldest first, pruned to the trend window. */
  samples: ModelSample[];
}

export const MODEL_KEYS = [
  'id',
  'provider',
  'name',
  'prompt',
  'completion',
  'context',
  'firstSeen',
  'lastSeen',
  'available',
  'samples',
] as const satisfies readonly (keyof ModelRow)[];

export type _ModelKeysExhaustive = AssertExhaustive<
  Exclude<keyof ModelRow, (typeof MODEL_KEYS)[number]>
>;
