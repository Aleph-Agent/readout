import { createHmac, randomBytes } from 'node:crypto';

/**
 * Posting to X, signed by hand.
 *
 * X requires OAuth 1.0a user context to post. Every library that does this
 * drags in a dependency tree for what is, in the end, an HMAC over a sorted
 * string. Writing it here keeps the project's promise of no runtime
 * dependencies and leaves nothing between a credential and the request.
 */

const ENDPOINT = 'https://api.x.com/2/tweets';

/** X's limit. Links count as a fixed 23 characters regardless of length. */
export const MAX_POST_LENGTH = 280;
const LINK_COST = 23;

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/**
 * RFC 3986 percent-encoding.
 *
 * encodeURIComponent leaves ! * ' ( ) alone, and OAuth requires them encoded.
 * A signature computed over a differently-encoded string simply fails, with no
 * indication of why.
 */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function signature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const normalised = Object.keys(params)
    .sort()
    .map((key) => `${encode(key)}=${encode(params[key] as string)}`)
    .join('&');

  const base = [method.toUpperCase(), encode(url), encode(normalised)].join('&');
  const key = `${encode(consumerSecret)}&${encode(tokenSecret)}`;

  return createHmac('sha1', key).update(base).digest('base64');
}

/**
 * The Authorization header for a request.
 *
 * A JSON body is not part of an OAuth 1.0a signature — only the OAuth
 * parameters and any query string are.
 */
export function authorizationHeader(
  method: string,
  url: string,
  credentials: XCredentials,
  now: () => number = Date.now,
  nonce: () => string = () => randomBytes(16).toString('hex'),
): string {
  const params: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: nonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };

  params['oauth_signature'] = signature(
    method,
    url,
    params,
    credentials.apiSecret,
    credentials.accessSecret,
  );

  const rendered = Object.keys(params)
    .sort()
    .map((key) => `${encode(key)}="${encode(params[key] as string)}"`)
    .join(', ');

  return `OAuth ${rendered}`;
}

/** Length as X counts it: every link is 23 characters whatever its real length. */
export function postLength(text: string): number {
  return text
    .split(/\s+/)
    .reduce((total, word) => total + (/^https?:\/\//.test(word) ? LINK_COST : word.length) + 1, -1);
}

export interface XClient {
  post(text: string): Promise<{ id: string }>;
  posts(): number;
}

export interface XClientOptions {
  credentials: XCredentials;
  fetchImpl?: typeof fetch;
}

export function createXClient(options: XClientOptions): XClient {
  const { credentials, fetchImpl = fetch } = options;

  for (const [name, value] of Object.entries(credentials)) {
    if (value.trim() === '') throw new Error(`createXClient: ${name} is empty`);
    if (!/^[\x21-\x7E]+$/.test(value)) {
      throw new Error(
        `createXClient: ${name} contains characters that cannot go in an HTTP header. ` +
          'A byte order mark or stray whitespace from a copy-paste is the usual cause.',
      );
    }
  }

  let posts = 0;

  return {
    posts: () => posts,

    async post(text: string): Promise<{ id: string }> {
      if (postLength(text) > MAX_POST_LENGTH) {
        // Truncating a claim mid-sentence is worse than not making it.
        throw new Error(`post is ${postLength(text)} characters, limit is ${MAX_POST_LENGTH}`);
      }

      posts += 1;

      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: authorizationHeader('POST', ENDPOINT, credentials),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // Never echo the credentials, and never echo a body that might contain
        // them reflected back.
        throw new Error(`X ${response.status}${response.status === 403 ? ' (check app write permission)' : ''}${detail.length < 200 ? `: ${detail}` : ''}`);
      }

      const body = (await response.json()) as { data?: { id?: string } };
      return { id: body.data?.id ?? 'unknown' };
    },
  };
}
