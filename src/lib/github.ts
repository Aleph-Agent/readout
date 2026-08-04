/**
 * Authenticated GitHub REST client.
 *
 * Every rule here comes from `free-tier-guard`. The budget is generous once
 * authenticated — roughly 4.4% of the daily ceiling at 400 repositories — so
 * the client is not optimised for speed. It is optimised for never tripping a
 * secondary rate limit, because that can restrict the token beyond the current
 * run, and for never spending budget it does not have to.
 */

const API_ROOT = 'https://api.github.com';

/** Stop the run cleanly below this many remaining requests. */
const DEFAULT_FLOOR = 500;

/** Retries apply to 5xx only. A 4xx is an answer, not a failure. */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Raised when the remaining rate-limit budget drops below the floor. The run
 * should write what it has and exit successfully with a warning — a partial run
 * is a normal outcome.
 */
export class BudgetExhaustedError extends Error {}

/**
 * Raised on a secondary rate limit. Unlike the primary budget this is a
 * behavioural penalty, so the correct response is to stop immediately rather
 * than back off and try again.
 */
export class SecondaryRateLimitError extends Error {}

export type Fetched<T> =
  | { status: 'ok'; data: T; etag: string | null }
  /** 304. The stored copy is current and this cost no budget. */
  | { status: 'unchanged' }
  /** 404. Deleted, renamed, or gone private. Mark inactive and continue. */
  | { status: 'missing' };

export interface ClientStats {
  /** Requests that actually consumed budget. 304s are excluded. */
  consumed: number;
  /** Conditional requests answered 304. High is good — ETags are working. */
  unchanged: number;
  /** `x-ratelimit-remaining` from the most recent response. */
  rateLimitRemaining: number | null;
}

export interface GitHubClientOptions {
  /**
   * Fine-grained personal access token with public-repository read access.
   * Never logged, never included in an error message.
   */
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  floor?: number;
  maxAttempts?: number;
  userAgent?: string;
}

export interface GitHubClient {
  /**
   * GET a JSON resource, replaying `etag` as `If-None-Match` when given.
   * Resolves to `unchanged` on 304 and `missing` on 404; throws on anything the
   * caller cannot sensibly continue past.
   */
  getJson<T>(path: string, etag?: string | null): Promise<Fetched<T>>;
  stats(): ClientStats;
  /** True once the budget floor was crossed. */
  isExhausted(): boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A 403 or 429 carrying `retry-after`, or citing a secondary limit, is the
 * abuse detector rather than the ordinary quota.
 */
function isSecondaryLimit(response: Response, body: string): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  if (response.headers.get('retry-after') !== null) return true;
  return /secondary rate limit/i.test(body);
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const {
    token,
    fetchImpl = fetch,
    sleep = defaultSleep,
    floor = DEFAULT_FLOOR,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    userAgent = 'unified-developer-signal-agent',
  } = options;

  if (token.trim() === '') {
    // Unauthenticated requests get 60/hour, which exhausts in seconds. Failing
    // loudly here beats discovering it a third of the way through a run.
    throw new Error('createGitHubClient: token is empty; unauthenticated calls are not permitted');
  }

  let consumed = 0;
  let unchanged = 0;
  let rateLimitRemaining: number | null = null;
  let exhausted = false;

  function noteRateLimit(response: Response): void {
    const header = response.headers.get('x-ratelimit-remaining');
    if (header === null) return;

    const remaining = Number.parseInt(header, 10);
    if (!Number.isFinite(remaining)) return;

    rateLimitRemaining = remaining;
    if (remaining < floor) exhausted = true;
  }

  async function getJson<T>(path: string, etag?: string | null): Promise<Fetched<T>> {
    if (exhausted) {
      throw new BudgetExhaustedError(
        `rate limit budget below floor (${String(rateLimitRemaining)} < ${floor}); stopping cleanly`,
      );
    }

    const url = path.startsWith('http') ? path : `${API_ROOT}${path}`;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': userAgent,
      'x-github-api-version': '2022-11-28',
    };
    if (etag) headers['if-none-match'] = etag;

    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetchImpl(url, { headers });
      noteRateLimit(response);

      if (response.status === 304) {
        unchanged += 1;
        return { status: 'unchanged' };
      }

      if (response.status === 404) {
        consumed += 1;
        return { status: 'missing' };
      }

      if (response.ok) {
        consumed += 1;
        const data = (await response.json()) as T;
        return { status: 'ok', data, etag: response.headers.get('etag') };
      }

      const body = await response.text().catch(() => '');
      consumed += 1;

      if (isSecondaryLimit(response, body)) {
        exhausted = true;
        throw new SecondaryRateLimitError(
          `secondary rate limit on ${path}; stopping the run rather than retrying`,
        );
      }

      // Primary quota genuinely empty. Same handling as the floor.
      if (rateLimitRemaining === 0) {
        exhausted = true;
        throw new BudgetExhaustedError(`rate limit exhausted on ${path}`);
      }

      if (response.status < 500) {
        // A 4xx is the server's answer. Retrying cannot change it and only
        // spends budget.
        throw new Error(`GitHub ${response.status} on ${path}`);
      }

      lastError = `GitHub ${response.status} on ${path}`;
      if (attempt < maxAttempts) {
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }

    throw new Error(`${lastError} (gave up after ${maxAttempts} attempts)`);
  }

  return {
    getJson,
    stats: () => ({ consumed, unchanged, rateLimitRemaining }),
    isExhausted: () => exhausted,
  };
}

/** Shape of `GET /repos/{owner}/{repo}`, narrowed to the fields we read. */
export interface RepoPayload {
  full_name: string;
  forks_count: number;
  stargazers_count: number;
  open_issues_count: number;
  language: string | null;
  pushed_at: string | null;
}

/** Shape of `GET /repos/{owner}/{repo}/releases/latest`, narrowed. */
export interface ReleasePayload {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}
