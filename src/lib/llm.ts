/**
 * Groq client with rate pacing.
 *
 * The free tier allows 30 requests/minute and 6,000 tokens/minute. The token
 * ceiling is the real constraint: at roughly a thousand tokens a call that is
 * about six calls a minute, so a pass over sixty events takes ten minutes.
 *
 * That is correct behaviour, not a problem. The job is not interactive and
 * nobody is waiting. Racing the limiter would only trip it.
 */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Model ids drift. Overridable so a deprecation is a secret change rather than
 * a code change and a redeploy.
 */
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

const REQUESTS_PER_MINUTE = 30;
const TOKENS_PER_MINUTE = 6_000;
const MAX_COMPLETION_TOKENS = 160;

const MINUTE_MS = 60_000;

export interface Pacer {
  /** Resolves once this many tokens fit inside both sliding windows. */
  acquire(tokens: number): Promise<void>;
}

export interface PacerOptions {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createPacer(options: PacerOptions = {}): Pacer {
  const {
    requestsPerMinute = REQUESTS_PER_MINUTE,
    tokensPerMinute = TOKENS_PER_MINUTE,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  const window: { at: number; tokens: number }[] = [];

  return {
    async acquire(tokens: number): Promise<void> {
      if (tokens > tokensPerMinute) {
        // No amount of waiting makes this fit. Fail loudly rather than spin.
        throw new Error(
          `pacer: a single call needs ${tokens} tokens, over the ${tokensPerMinute}/minute ceiling`,
        );
      }

      for (;;) {
        const cutoff = now() - MINUTE_MS;
        while (window.length > 0 && (window[0] as { at: number }).at <= cutoff) window.shift();

        const spent = window.reduce((total, entry) => total + entry.tokens, 0);
        if (window.length < requestsPerMinute && spent + tokens <= tokensPerMinute) {
          window.push({ at: now(), tokens });
          return;
        }

        const oldest = window[0];
        if (oldest === undefined) return;
        await sleep(Math.max(1, oldest.at + MINUTE_MS - now()));
      }
    },
  };
}

/** Rough token estimate. Deliberately generous — overestimating costs patience. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + MAX_COMPLETION_TOKENS;
}

export interface LlmClient {
  /** Returns the model's raw text, untrimmed and unvalidated. */
  complete(system: string, user: string): Promise<string>;
  model: string;
  /** Calls that actually reached the API. */
  calls(): number;
}

export interface LlmClientOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  pacer?: Pacer;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface GroqResponse {
  choices?: { message?: { content?: string } }[];
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const {
    apiKey,
    model = process.env['GROQ_MODEL'] ?? DEFAULT_MODEL,
    fetchImpl = fetch,
    pacer = createPacer(),
    maxAttempts = 3,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  if (apiKey.trim() === '') throw new Error('createLlmClient: GROQ_API_KEY is empty');

  let calls = 0;

  return {
    model,
    calls: () => calls,

    async complete(system: string, user: string): Promise<string> {
      await pacer.acquire(estimateTokens(system + user));

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        calls += 1;

        const response = await fetchImpl(GROQ_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            // Near-deterministic: this is a description of numbers, not a
            // creative writing task, and reproducibility matters more than
            // variety when the output is a public claim.
            temperature: 0.2,
            max_tokens: MAX_COMPLETION_TOKENS,
          }),
        });

        if (response.status === 429) {
          // The pacer should prevent this. If it happens anyway, respect the
          // server's own number rather than guessing.
          const retryAfter = Number.parseFloat(response.headers.get('retry-after') ?? '5');
          await sleep((Number.isFinite(retryAfter) ? retryAfter : 5) * 1000);
          continue;
        }

        if (!response.ok) {
          if (response.status < 500 || attempt === maxAttempts) {
            throw new Error(`Groq ${response.status}`);
          }
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }

        const body = (await response.json()) as GroqResponse;
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('Groq returned no content');
        return content;
      }

      throw new Error(`Groq gave up after ${maxAttempts} attempts`);
    },
  };
}
