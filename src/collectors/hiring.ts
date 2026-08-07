/**
 * What people are being paid to use.
 *
 * Every other signal in this product measures what developers publish. This
 * measures what employers are willing to pay for, which is the one demand
 * signal that costs somebody money to express — and the two disagree often
 * enough to be worth watching side by side. A framework can be the most starred
 * thing on GitHub and appear in four job posts.
 *
 * Hacker News posts one "Who is hiring?" thread a month and has done for over a
 * decade. Every top-level comment is one job post, the archive is free and
 * unauthenticated through Algolia, and nobody publishes the cross-tabulation.
 *
 * The sample is narrow and the page has to say so in the same breath as the
 * number: this is one forum, skewed hard toward American startups, and a few
 * hundred posts a month. It is evidence about that population and nothing
 * wider.
 */

import type { HiringRow } from '../types/hiring.ts';
import { sleep } from '../lib/registries.ts';

const API = 'https://hn.algolia.com/api/v1';
const USER_AGENT = 'sighttrue-agent (+https://github.com/kaitzyy-dev/sighttrue)';

/** Algolia's ceiling for one page, and larger than any thread has ever been. */
const PAGE_SIZE = 1000;

export const DELAY_MS = 250;

/** Threads read per run. Two, so last month is complete before it is compared. */
export const MONTHS = 2;

interface Term {
  term: string;
  pattern: RegExp;
  /** True where the pattern is deliberately narrow. See `HiringRow`. */
  conservative?: boolean;
}

/**
 * Curated, with an explicit pattern each rather than a name matched loosely.
 *
 * Word boundaries are not enough on their own. `\bgo\b` matches "go to
 * production" and would report Go as the most in-demand language on earth; `\br\b`
 * matches nothing useful at all. Those are matched only beside a word that
 * makes them technical, which undercounts, and the undercount is declared on
 * the row rather than hidden in the number.
 */
export const TERMS: readonly Term[] = [
  { term: 'TypeScript', pattern: /\btypescript\b/i },
  { term: 'JavaScript', pattern: /\bjavascript\b/i },
  { term: 'Python', pattern: /\bpython\b/i },
  { term: 'Rust', pattern: /\brust\b/i },
  {
    term: 'Go',
    // "Go" alone is ordinary English. Only counted where the sentence cannot
    // mean anything else.
    pattern: /\bgolang\b|\bgo\b(?=\s*[,/|)])|\bgo\b(?=\s+(?:developer|engineer|backend|services?|microservices?))/i,
    conservative: true,
  },
  { term: 'Java', pattern: /\bjava\b(?!script)/i },
  { term: 'Kotlin', pattern: /\bkotlin\b/i },
  { term: 'Swift', pattern: /\bswift\b/i },
  { term: 'Ruby', pattern: /\bruby\b/i },
  { term: 'PHP', pattern: /\bphp\b/i },
  { term: 'Elixir', pattern: /\belixir\b/i },
  { term: 'Scala', pattern: /\bscala\b/i },
  { term: 'C++', pattern: /c\+\+/i },
  { term: 'C#', pattern: /c#|\.net\b/i },
  { term: 'Clojure', pattern: /\bclojure\b/i },
  { term: 'Haskell', pattern: /\bhaskell\b/i },
  { term: 'Zig', pattern: /\bzig\b/i },

  { term: 'React', pattern: /\breact\b(?!ive)/i },
  { term: 'Vue', pattern: /\bvue(?:\.js)?\b/i },
  { term: 'Svelte', pattern: /\bsvelte(?:kit)?\b/i },
  { term: 'Angular', pattern: /\bangular\b/i },
  { term: 'Next.js', pattern: /\bnext\.?js\b/i },
  { term: 'Tailwind', pattern: /\btailwind\b/i },

  { term: 'Node.js', pattern: /\bnode(?:\.js)?\b/i },
  { term: 'Django', pattern: /\bdjango\b/i },
  { term: 'Rails', pattern: /\b(?:ruby on )?rails\b/i },
  { term: 'Laravel', pattern: /\blaravel\b/i },
  { term: 'Spring', pattern: /\bspring ?boot\b|\bspring framework\b/i, conservative: true },
  { term: 'FastAPI', pattern: /\bfastapi\b/i },

  { term: 'PostgreSQL', pattern: /\bpostgre?s(?:ql)?\b/i },
  { term: 'MySQL', pattern: /\bmysql\b/i },
  { term: 'MongoDB', pattern: /\bmongo(?:db)?\b/i },
  { term: 'Redis', pattern: /\bredis\b/i },
  { term: 'Kafka', pattern: /\bkafka\b/i },
  { term: 'Snowflake', pattern: /\bsnowflake\b/i },
  { term: 'ClickHouse', pattern: /\bclickhouse\b/i },
  { term: 'DuckDB', pattern: /\bduckdb\b/i },
  { term: 'Elasticsearch', pattern: /\belasticsearch\b/i },

  { term: 'Kubernetes', pattern: /\bkubernetes\b|\bk8s\b/i },
  { term: 'Docker', pattern: /\bdocker\b/i },
  { term: 'Terraform', pattern: /\bterraform\b/i },
  { term: 'AWS', pattern: /\baws\b|\bamazon web services\b/i },
  { term: 'GCP', pattern: /\bgcp\b|\bgoogle cloud\b/i },
  { term: 'Azure', pattern: /\bazure\b/i },
  { term: 'Cloudflare', pattern: /\bcloudflare\b/i },

  { term: 'PyTorch', pattern: /\bpytorch\b/i },
  { term: 'TensorFlow', pattern: /\btensorflow\b/i },
  { term: 'LangChain', pattern: /\blangchain\b/i },
  { term: 'LLM', pattern: /\bllms?\b|\blarge language models?\b/i },
  { term: 'RAG', pattern: /\brag\b(?=\s|,|\.|\))/i, conservative: true },

  { term: 'GraphQL', pattern: /\bgraphql\b/i },
  { term: 'gRPC', pattern: /\bgrpc\b/i },
];

interface Story {
  id: string;
  month: string;
}

export interface HiringClient {
  /** Newest "Who is hiring?" threads, newest first. */
  threads(): Promise<Story[]>;
  /** Every top-level post in one thread, as plain text. */
  posts(storyId: string): Promise<string[]>;
  requests(): number;
}

/** HTML out, words in. The comments arrive as escaped markup. */
export function toText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

export function createHiringClient(): HiringClient {
  let spent = 0;
  const get = async (path: string): Promise<unknown> => {
    spent += 1;
    const response = await fetch(`${API}${path}`, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`${response.status} from ${path}`);
    return response.json();
  };

  return {
    requests: () => spent,

    async threads() {
      const body = (await get(
        '/search_by_date?tags=story,author_whoishiring&hitsPerPage=12',
      )) as { hits?: { objectID?: string; title?: string; created_at?: string }[] };

      return (body.hits ?? [])
        .filter((hit) => /who is hiring/i.test(hit.title ?? ''))
        .map((hit) => ({
          id: String(hit.objectID ?? ''),
          month: String(hit.created_at ?? '').slice(0, 7),
        }))
        .filter((story) => story.id !== '' && /^\d{4}-\d{2}$/.test(story.month));
    },

    async posts(storyId) {
      const body = (await get(
        `/search?tags=comment,story_${storyId}&hitsPerPage=${PAGE_SIZE}`,
      )) as { hits?: { comment_text?: string | null }[] };

      return (body.hits ?? [])
        .map((hit) => toText(hit.comment_text ?? ''))
        .filter((text) => text.trim() !== '');
    },
  };
}

/** Posts naming each term. One post counts once however often it says the word. */
export function countTerms(posts: readonly string[], month: string): HiringRow[] {
  return TERMS.map((entry) => ({
    month,
    term: entry.term,
    posts: posts.filter((post) => entry.pattern.test(post)).length,
    sample: posts.length,
    conservative: entry.conservative === true,
  })).filter((row) => row.posts > 0);
}

export interface HiringCollectionResult {
  rows: HiringRow[];
  errors: string[];
  requests: number;
}

export interface HiringCollectionOptions {
  client?: HiringClient;
  months?: number;
  delayMs?: number;
}

export async function collectHiring(
  previous: readonly HiringRow[],
  options: HiringCollectionOptions = {},
): Promise<HiringCollectionResult> {
  const client = options.client ?? createHiringClient();
  const errors: string[] = [];

  let threads: Story[];
  try {
    threads = await client.threads();
  } catch (error) {
    // Every month already read stays read. A search that fails says nothing
    // about whether anybody was hiring.
    return {
      rows: [...previous],
      errors: [`hiring: ${error instanceof Error ? error.message : String(error)}`],
      requests: client.requests(),
    };
  }

  const wanted = threads.slice(0, options.months ?? MONTHS);
  const byKey = new Map(previous.map((row) => [`${row.month} ${row.term}`, row]));

  for (const [index, story] of wanted.entries()) {
    if (index > 0) await sleep(options.delayMs ?? DELAY_MS);

    let posts: string[];
    try {
      posts = await client.posts(story.id);
    } catch (error) {
      errors.push(
        `hiring ${story.month}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (posts.length === 0) {
      // A thread posted an hour ago genuinely has none. Overwriting last
      // month's counts with zeroes on the first of the month would erase a
      // complete reading and replace it with an empty one.
      errors.push(`hiring ${story.month}: no posts read`);
      continue;
    }

    // The current month's thread grows all month, so its row is replaced on
    // every run rather than added to. Older months are settled and are left as
    // they were first read.
    for (const [key] of byKey) {
      if (key.startsWith(`${story.month} `)) byKey.delete(key);
    }
    for (const row of countTerms(posts, story.month)) {
      byKey.set(`${row.month} ${row.term}`, row);
    }
  }

  return { rows: [...byKey.values()], errors, requests: client.requests() };
}
