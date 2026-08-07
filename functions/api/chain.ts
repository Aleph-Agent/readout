/**
 * Can this deployment reach the chain.
 *
 * Payment verification reads a transaction receipt over JSON-RPC. If the
 * network path from a Worker to the chain does not exist, nothing downstream of
 * it can work, and finding that out when the first buyer is waiting is the
 * wrong time.
 *
 * It could not be answered from a laptop: the official RPC refused the
 * connection outright and the public Blockscout endpoint rate-limited a shared
 * address. Neither says anything about the path from Cloudflare's network,
 * which is the only path that matters, so the question is asked from there.
 *
 * Kept rather than thrown away. Once money depends on this, "is the chain
 * reachable" is an operational question somebody will ask again — during an
 * outage, after a provider change, when a payment does not land — and it should
 * have an answer that is one request away rather than a debugging session.
 *
 * Reads only. No key, no address, no state, nothing to spend.
 */

/**
 * Endpoints, in order of preference.
 *
 * More than one on purpose. A single hardcoded provider is a single point of
 * failure for the one part of this system where failing means somebody paid and
 * got nothing.
 */
const ENDPOINTS = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhoodchain.blockscout.com/api/eth-rpc',
] as const;

/** Robinhood Chain. Anything else means a misconfigured endpoint. */
const EXPECTED_CHAIN_ID = 4663;

const HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

interface Probe {
  endpoint: string;
  reachable: boolean;
  chainId: number | null;
  blockNumber: number | null;
  /** Round trip in milliseconds, as measured from the edge. */
  ms: number | null;
  error: string | null;
}

async function rpc(endpoint: string, method: string, params: unknown[] = []): Promise<string> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());

  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'rpc error');
  if (typeof body.result !== 'string') throw new Error('no result');

  return body.result;
}

async function probe(endpoint: string): Promise<Probe> {
  const started = Date.now();

  try {
    const chainId = Number.parseInt(await rpc(endpoint, 'eth_chainId'), 16);
    const blockNumber = Number.parseInt(await rpc(endpoint, 'eth_blockNumber'), 16);

    return {
      endpoint,
      reachable: true,
      chainId: Number.isFinite(chainId) ? chainId : null,
      blockNumber: Number.isFinite(blockNumber) ? blockNumber : null,
      ms: Date.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      endpoint,
      reachable: false,
      chainId: null,
      blockNumber: null,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function onRequestGet(): Promise<Response> {
  // Both at once. Sequentially, a hanging endpoint would make the healthy one
  // look slow, and the point is to compare them.
  const probes = await Promise.all(ENDPOINTS.map((endpoint) => probe(endpoint)));
  const usable = probes.filter(
    (result) => result.reachable && result.chainId === EXPECTED_CHAIN_ID,
  );

  return new Response(
    JSON.stringify(
      {
        // The one question this endpoint exists to answer.
        canVerifyPayments: usable.length > 0,
        expectedChainId: EXPECTED_CHAIN_ID,
        head: usable[0]?.blockNumber ?? null,
        endpoints: probes,
        note: 'Read-only reachability check for the payment verifier. No key, no state, nothing spendable.',
      },
      null,
      2,
    ),
    { headers: HEADERS },
  );
}

export function onRequestOptions(): Response {
  return new Response(null, { status: 204, headers: HEADERS });
}
