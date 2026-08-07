import type { AssertExhaustive } from './keys.ts';

/**
 * Questions asked about one tag across two equal windows.
 *
 * Both windows are stored rather than a computed change, because the change is
 * a derived figure and this file is the reading. Storing only the delta would
 * leave nobody able to check it, and would hide the case that matters most: a
 * tag falling from four questions to two is a 50% drop and means nothing.
 */
export interface QuestionRow {
  /** Tag as Stack Overflow spells it. */
  tag: string;
  /** Days in each window. */
  windowDays: number;
  /** Questions in the most recent window. */
  recent: number;
  /** Questions in the window before it. */
  earlier: number;
  /** `YYYY-MM-DD` the windows were measured back from. */
  observedAt: string;
}

export const QUESTION_KEYS = [
  'tag',
  'windowDays',
  'recent',
  'earlier',
  'observedAt',
] as const satisfies readonly (keyof QuestionRow)[];

export type _QuestionKeysExhaustive = AssertExhaustive<
  Exclude<keyof QuestionRow, (typeof QUESTION_KEYS)[number]>
>;
