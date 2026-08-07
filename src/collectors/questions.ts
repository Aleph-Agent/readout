/**
 * Whether anybody is still asking.
 *
 * Stars accumulate and never fall, downloads count machines rather than people,
 * and a repository can look alive on both while nobody has had a question about
 * it in a year. Question volume is the only signal here that can go to zero,
 * which makes it the only one that can say a thing has stopped being used
 * rather than merely stopped growing.
 *
 * It is also the most confounded. Volume falls when a tool dies and it falls
 * when a tool gets good documentation, and it has fallen across every tag on
 * the site since assistants started answering these questions instead. The
 * comparison that survives all three is between tags over the same window, not
 * a tag against its own past — and the page has to say so.
 *
 * Stack Exchange allows 300 requests a day unauthenticated, which is far more
 * than two windows across thirty tags needs.
 */

import type { QuestionRow } from '../types/questions.ts';
import { sleep } from '../lib/registries.ts';

const API = 'https://api.stackexchange.com/2.3';
const USER_AGENT = 'sighttrue-agent (+https://github.com/kaitzyy-dev/sighttrue)';

export const DELAY_MS = 300;

/** Days per window. Two of these are compared, so sixty days of reading. */
export const WINDOW_DAYS = 30;

/** Tags as Stack Overflow spells them, which is not always as anyone else does. */
export const TAGS: readonly string[] = [
  'reactjs',
  'vue.js',
  'svelte',
  'angular',
  'next.js',
  'typescript',
  'python',
  'rust',
  'go',
  'java',
  'kotlin',
  'swift',
  'ruby-on-rails',
  'django',
  'laravel',
  'spring-boot',
  'node.js',
  'deno',
  'bun',
  'postgresql',
  'mysql',
  'mongodb',
  'redis',
  'elasticsearch',
  'kubernetes',
  'docker',
  'terraform',
  'tailwind-css',
  'pytorch',
  'tensorflow',
];

export interface QuestionClient {
  /** Questions asked with this tag between two unix seconds. */
  total(tag: string, from: number, to: number): Promise<number | null>;
  requests(): number;
}

export function createQuestionClient(): QuestionClient {
  let spent = 0;
  return {
    requests: () => spent,
    async total(tag, from, to) {
      spent += 1;
      // `filter=total` returns the count and nothing else — no question bodies,
      // no author names. The only figure wanted, and the smallest response the
      // API will produce.
      const response = await fetch(
        `${API}/questions?site=stackoverflow&tagged=${encodeURIComponent(tag)}&fromdate=${from}&todate=${to}&filter=total`,
        { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } },
      );
      if (!response.ok) return null;

      const body = (await response.json()) as { total?: number };
      return typeof body.total === 'number' ? body.total : null;
    },
  };
}

export interface QuestionCollectionResult {
  rows: QuestionRow[];
  errors: string[];
  requests: number;
}

export interface QuestionCollectionOptions {
  /** `YYYY-MM-DD` UTC. Both windows are measured back from here. */
  today: string;
  client?: QuestionClient;
  tags?: readonly string[];
  delayMs?: number;
  windowDays?: number;
}

export async function collectQuestions(
  previous: readonly QuestionRow[],
  options: QuestionCollectionOptions,
): Promise<QuestionCollectionResult> {
  const client = options.client ?? createQuestionClient();
  const tags = options.tags ?? TAGS;
  const days = options.windowDays ?? WINDOW_DAYS;
  const errors: string[] = [];

  const end = Math.floor(Date.parse(`${options.today}T00:00:00Z`) / 1000);
  const mid = end - days * 86_400;
  const start = mid - days * 86_400;

  const held = new Map(previous.map((row) => [row.tag, row]));
  const rows: QuestionRow[] = [];

  for (const [index, tag] of tags.entries()) {
    if (index > 0) await sleep(options.delayMs ?? DELAY_MS);

    let recent: number | null;
    let earlier: number | null;
    try {
      recent = await client.total(tag, mid, end);
      await sleep(options.delayMs ?? DELAY_MS);
      earlier = await client.total(tag, start, mid);
    } catch (error) {
      errors.push(
        `questions ${tag}: ${error instanceof Error ? error.message : String(error)}`,
      );
      const previousRow = held.get(tag);
      if (previousRow !== undefined) rows.push(previousRow);
      continue;
    }

    if (recent === null || earlier === null) {
      // A quota refusal and a tag with no questions look the same at the call
      // site and are not the same fact, so an unreadable window keeps the last
      // one rather than being written as zero.
      errors.push(`questions ${tag}: window unreadable`);
      const previousRow = held.get(tag);
      if (previousRow !== undefined) rows.push(previousRow);
      continue;
    }

    rows.push({
      tag,
      windowDays: days,
      recent,
      earlier,
      observedAt: options.today,
    });
  }

  return { rows, errors, requests: client.requests() };
}
