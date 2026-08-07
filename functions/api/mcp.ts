/**
 * A Model Context Protocol server over the published bundles.
 *
 * Coding agents now sit between a developer and most dependency decisions, and
 * they answer "is this package healthy" from training data that is a year old.
 * This lets them answer it from a reading taken today.
 *
 * It is the second public surface on this project and by far the safer of the
 * two. `/api/ask` holds an API key, calls a third party, and spends a quota
 * somebody could drain. This holds nothing, calls nothing but its own origin,
 * writes nothing, and has no quota to exhaust. The worst an abusive client can
 * do is read files that are already public at their own URLs.
 *
 * JSON-RPC 2.0 over the Streamable HTTP transport. Deliberately minimal: no
 * sessions, no server-initiated messages, no subscriptions. A stateless
 * request-response server is a complete MCP server for read-only data, and
 * every piece of state omitted is a piece that cannot go wrong.
 *
 * Every failure path returns a JSON-RPC error object. Nothing here throws to
 * the runtime, because a 500 from an MCP server presents to the agent as "the
 * tool is broken" rather than as "that argument was wrong".
 */

/** Versions this server implements, newest first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

const SERVER = { name: 'readout', version: '1.0.0' } as const;

/** Beyond this an argument is not a package name, it is an attack. */
const MAX_NAME = 200;

/** One agent call must not be able to ask for the whole watchlist. */
const MAX_BATCH = 100;
const MAX_RESULTS = 50;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface StackEntry {
  repo: string;
  installs: number | null;
  scorecard: number | null;
  advisories: number | null;
  license: string | null;
  archived: boolean;
  pushedAt: string | null;
}

interface CompareRow {
  id: string;
  name: string;
  category: string;
  language: string | null;
  forks: number;
  stars: number;
  installs: number | null;
  scorecard: number | null;
  advisories: number | null;
  findings: number;
}

interface IncidentBundle {
  generatedAt: string;
  incidents: {
    provider: string;
    title: string;
    startedAt: string;
    resolved: boolean;
    url: string;
  }[];
}

interface EolBundle {
  generatedAt: string;
  products: {
    product: string;
    cycle: string;
    eol: string | null;
    ended: boolean;
    latest: string | null;
    lts: boolean;
  }[];
}

interface StackIndex {
  benchmark: { repositories: number; medianScorecard: number | null; scored: number };
  packages: Record<string, StackEntry>;
}

const HEADERS = {
  'content-type': 'application/json',
  // Agents run in browsers as often as not, and this data is public at its own
  // URLs anyway — there is nothing here that same-origin policy would protect.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, mcp-protocol-version',
  'access-control-allow-methods': 'POST, OPTIONS',
  'cache-control': 'no-store',
};

function result(id: unknown, value: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: value }), {
    headers: HEADERS,
  });
}

/**
 * A JSON-RPC error, always with HTTP 200.
 *
 * The transport succeeded; the call did not. Returning 4xx here makes clients
 * report a broken server rather than a rejected argument, and the difference
 * matters when the caller is an agent deciding whether to retry.
 */
function failure(id: unknown, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), {
    headers: HEADERS,
  });
}

/** Tool results are content blocks, and an error is a flag rather than a throw. */
function toolResult(id: unknown, payload: unknown, isError = false): Response {
  return result(id, {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError,
  });
}

function asString(value: unknown, max = MAX_NAME): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) return null;
  return trimmed;
}

const TOOLS = [
  {
    name: 'check_package',
    description:
      'Read the current standing of one open-source package: weekly downloads, OpenSSF scorecard, advisory count, licence, whether the repository is archived, and when it was last pushed to. Covers a curated watchlist of around 400 projects; a package that is not covered returns covered:false and is not being judged.',
    inputSchema: {
      type: 'object',
      properties: {
        registry: { type: 'string', enum: ['npm', 'pypi', 'crates'] },
        name: { type: 'string', description: 'Package name as the registry spells it.' },
      },
      required: ['registry', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_stack',
    description:
      'Read a whole dependency list at once and report what is archived, what carries advisories, what has a source-available licence, and what has not been pushed to in a year. Also returns how the stack medians against the tracked corpus. Use this when reviewing a package.json, requirements.txt or Cargo.toml.',
    inputSchema: {
      type: 'object',
      properties: {
        registry: { type: 'string', enum: ['npm', 'pypi', 'crates'] },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: `Package names, up to ${MAX_BATCH}.`,
        },
      },
      required: ['registry', 'names'],
      additionalProperties: false,
    },
  },
  {
    name: 'compare_repositories',
    description:
      'Hold two watched repositories against each other across downloads, OpenSSF scorecard, advisories, forks, stars and findings on record. Compares only; it does not rank, and nothing is totalled across measures that share no unit.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'Repository as owner/name.' },
        b: { type: 'string', description: 'Repository as owner/name.' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_model',
    description:
      'Find language models by price and context window, from a catalogue read daily across sixty providers. Use this before choosing a model: prices move weekly and span four orders of magnitude, and no dated record of them exists anywhere else, so a model chosen from memory is usually chosen on a price that has since changed.',
    inputSchema: {
      type: 'object',
      properties: {
        minContext: { type: 'integer', description: 'Minimum context window in tokens.' },
        maxPrice: {
          type: 'number',
          description: 'Maximum USD per million prompt tokens.',
        },
        provider: { type: 'string', description: 'Restrict to one provider, e.g. anthropic.' },
        sort: {
          type: 'string',
          enum: ['price', 'context', 'price-per-context'],
          description:
            'price-per-context is cost per million divided by hundred-thousands of window — the right ordering when the job needs the window, and published nowhere else.',
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'check_eol',
    description:
      'Check whether a runtime, database or framework release is still receiving security fixes, and what to move to. Covers about two dozen products read daily from endoflife.date. Use it before recommending or accepting a version pin: end-of-life dates are published years ahead, so a date held in training data is usually the one thing that has since passed.',
    inputSchema: {
      type: 'object',
      properties: {
        product: {
          type: 'string',
          description: 'Product as endoflife.date spells it, e.g. python, nodejs, postgresql.',
        },
        cycle: {
          type: 'string',
          description: 'Release line, e.g. 3.9 or 20. Omit for every cycle of the product.',
        },
      },
      required: ['product'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_provider',
    description:
      "Read a provider's announced incident history — how many they have filed, how recently, and what they called them. Covers about twenty services developers depend on, kept after the providers' own status feeds stop carrying it. A count measures how often they announced something, not how often they broke, so a low number is not a good one.",
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider slug, e.g. cloudflare, openai, github. Omit for every provider.',
        },
        days: { type: 'integer', minimum: 1, maximum: 730, description: 'Window. Default 90.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_repositories',
    description:
      'Find watched repositories whose name contains a string, with their current readings. Use it to discover what is covered before calling the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * The caveats every answer carries.
 *
 * An agent will paste these figures into a code review, so the limits have to
 * travel with them. A scorecard quoted without "measures declared practices,
 * not whether the project is safe" is a claim this project does not make.
 */
const LIMITS = [
  'The watchlist is curated and partial, around 400 repositories chosen by hand. A package that is not covered is not being judged; it is simply not tracked.',
  'Scorecards are the OpenSSF Scorecard published by Google Open Source Insights, not computed here. They measure declared practices such as code review and workflow permissions, and a low score is not a statement that a project is unsafe.',
  'Advisory counts are OSV totals for all time, so a mature well-patched project carries more than a young one. A high count is not a warning on its own.',
  'Readings are taken every four hours at best. Nothing here is real-time.',
];

async function loadJson<T>(origin: string, path: string): Promise<T | null> {
  try {
    const response = await fetch(`${origin}${path}`, {
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function ageDays(iso: string | null): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.round((Date.now() - at) / 86_400_000) : null;
}

function eolDays(date: string, today: string): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

const SOURCE_AVAILABLE = /BUSL|SSPL|Elastic|RSAL|Commons-Clause|PolyForm/i;

function describe(name: string, entry: StackEntry): Record<string, unknown> {
  const age = ageDays(entry.pushedAt);
  return {
    name,
    covered: true,
    repository: entry.repo,
    weeklyDownloads: entry.installs,
    scorecard: entry.scorecard,
    advisories: entry.advisories,
    license: entry.license,
    licenseIsSourceAvailable: entry.license !== null && SOURCE_AVAILABLE.test(entry.license),
    archived: entry.archived,
    daysSinceLastPush: age,
    url: `https://readout-7pt.pages.dev/repo/${entry.repo}`,
  };
}

export async function onRequestPost(context: { request: Request }): Promise<Response> {
  const { request } = context;
  const origin = new URL(request.url).origin;

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return failure(null, -32700, 'Parse error: body is not JSON.');
  }

  // Batches are optional in JSON-RPC and this server does not accept them. Said
  // plainly rather than crashing on an array.
  if (Array.isArray(body)) {
    return failure(null, -32600, 'Batched requests are not supported. Send one request.');
  }
  if (body === null || typeof body !== 'object') {
    return failure(null, -32600, 'Invalid request.');
  }

  const id = body.id;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and expect no body.
  if (method.startsWith('notifications/')) return new Response(null, { status: 202 });

  if (method === 'initialize') {
    const asked = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
    const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
      ? asked
      : PROTOCOL_VERSIONS[0];

    return result(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: SERVER,
      instructions:
        'Readings about open-source dependencies, taken every four hours and published as static files. Every figure is measured rather than estimated, and every tool result carries the limits of what it can support. The watchlist is curated and partial: an uncovered package is untracked, not judged.',
    });
  }

  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: TOOLS });

  if (method !== 'tools/call') {
    return failure(id, -32601, `Method not found: ${method || '(none)'}`);
  }

  const toolName = typeof params['name'] === 'string' ? params['name'] : '';
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;

  if (toolName === 'check_package' || toolName === 'check_stack') {
    const registry = asString(args['registry'], 12);
    if (registry === null || !['npm', 'pypi', 'crates'].includes(registry)) {
      return toolResult(id, { error: 'registry must be one of npm, pypi, crates.' }, true);
    }

    const index = await loadJson<StackIndex>(origin, '/data/stack-index.json');
    if (index === null) {
      return toolResult(id, { error: 'The readings could not be loaded.' }, true);
    }

    if (toolName === 'check_package') {
      // Says which of the two it was. "name is required" for a name that was
      // supplied but is 5,000 characters long tells an agent to retry with the
      // same argument, and it will.
      const name = asString(args['name']);
      if (name === null) {
        return toolResult(
          id,
          {
            error:
              typeof args['name'] === 'string'
                ? `name must be between 1 and ${MAX_NAME} characters.`
                : 'name is required and must be a string.',
          },
          true,
        );
      }

      const entry = index.packages[`${registry}:${name}`];
      return toolResult(id, {
        ...(entry === undefined
          ? {
              name,
              covered: false,
              note: 'Not on the watchlist. This is not a judgement about the package — it is not tracked here.',
            }
          : describe(name, entry)),
        limits: LIMITS,
      });
    }

    const raw = args['names'];
    if (!Array.isArray(raw)) return toolResult(id, { error: 'names must be an array.' }, true);
    if (raw.length > MAX_BATCH) {
      return toolResult(id, { error: `names is limited to ${MAX_BATCH} entries.` }, true);
    }

    const wanted = raw.map((value) => asString(value)).filter((value): value is string => value !== null);
    const covered = wanted
      .map((name) => ({ name, entry: index.packages[`${registry}:${name}`] }))
      .filter((row): row is { name: string; entry: StackEntry } => row.entry !== undefined)
      .map((row) => describe(row.name, row.entry));

    const scored = covered
      .map((row) => row['scorecard'])
      .filter((score): score is number => typeof score === 'number')
      .sort((x, y) => x - y);

    return toolResult(id, {
      read: wanted.length,
      covered: covered.length,
      uncovered: wanted.length - covered.length,
      flags: {
        archived: covered.filter((row) => row['archived'] === true).map((row) => row['name']),
        sourceAvailableLicence: covered
          .filter((row) => row['licenseIsSourceAvailable'] === true)
          .map((row) => row['name']),
        withAdvisories: covered
          .filter((row) => typeof row['advisories'] === 'number' && (row['advisories'] as number) > 0)
          .map((row) => row['name']),
        notPushedInAYear: covered
          .filter(
            (row) =>
              typeof row['daysSinceLastPush'] === 'number' &&
              (row['daysSinceLastPush'] as number) > 365,
          )
          .map((row) => row['name']),
      },
      medianScorecard: scored.length === 0 ? null : scored[Math.floor(scored.length / 2)],
      benchmarkMedianScorecard: index.benchmark.medianScorecard,
      benchmarkRepositories: index.benchmark.repositories,
      packages: covered,
      limits: LIMITS,
    });
  }

  if (toolName === 'find_model') {
    const models = await loadJson<
      {
        id: string;
        provider: string;
        prompt: number | null;
        completion: number | null;
        context: number | null;
        firstSeen: string;
      }[]
    >(origin, '/data/models.json');

    if (models === null) {
      return toolResult(id, { error: 'The catalogue could not be loaded.' }, true);
    }

    const minContext = typeof args['minContext'] === 'number' ? args['minContext'] : 0;
    const maxPrice =
      typeof args['maxPrice'] === 'number' ? args['maxPrice'] : Number.POSITIVE_INFINITY;
    const provider = asString(args['provider'], 60)?.toLowerCase() ?? null;
    const sort = asString(args['sort'], 24) ?? 'price';
    const limitRaw = args['limit'];
    const limit =
      typeof limitRaw === 'number' && Number.isFinite(limitRaw)
        ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(limitRaw)))
        : 10;

    // Free tiers are excluded. Zero is a different offer — rate-limited, often
    // a preview — and returning it as the cheapest would answer the question
    // asked with something that is not an answer to it.
    const matched = models
      .filter(
        (model) =>
          typeof model.prompt === 'number' &&
          model.prompt > 0 &&
          model.prompt <= maxPrice &&
          (model.context ?? 0) >= minContext &&
          (provider === null || model.provider.toLowerCase() === provider),
      )
      .map((model) => ({
        ...model,
        perContext:
          model.context === null || model.context <= 0
            ? null
            : Math.round(((model.prompt as number) / (model.context / 100_000)) * 1_000_000) /
              1_000_000,
      }));

    matched.sort((a, b) => {
      if (sort === 'context') return (b.context ?? 0) - (a.context ?? 0);
      if (sort === 'price-per-context') {
        return (a.perContext ?? Infinity) - (b.perContext ?? Infinity);
      }
      return (a.prompt as number) - (b.prompt as number);
    });

    return toolResult(id, {
      matched: matched.length,
      returned: Math.min(limit, matched.length),
      sortedBy: sort,
      units: {
        prompt: 'USD per million prompt tokens',
        perContext: 'USD per million prompt tokens, per 100k of context window',
      },
      models: matched.slice(0, limit),
      limits: [
        'Prices are read daily from one catalogue and are what that catalogue reports, not what a provider bills you — quotas, batch tiers and negotiated rates are not visible here.',
        'Free tiers are excluded. Zero is a different offer rather than a lower price.',
        'A context window is what the catalogue advertises. It is not a statement about how well a model uses it.',
      ],
    });
  }

  if (toolName === 'check_eol') {
    const product = asString(args['product'], 60)?.toLowerCase() ?? null;
    if (product === null) {
      return toolResult(id, { error: 'product is required, e.g. python.' }, true);
    }

    const bundle = await loadJson<EolBundle>(origin, '/data/eol.json');
    if (bundle === null) {
      return toolResult(id, { error: 'The dates could not be loaded.' }, true);
    }

    const all = bundle.products.filter((row) => row.product === product);
    if (all.length === 0) {
      return toolResult(id, {
        product,
        covered: false,
        note: 'Not tracked here. This says nothing about the product; the list is curated.',
        tracked: [...new Set(bundle.products.map((row) => row.product))].sort(),
      });
    }

    const cycle = asString(args['cycle'], 40);
    const asked = cycle === null ? all : all.filter((row) => row.cycle === cycle);

    if (cycle !== null && asked.length === 0) {
      return toolResult(
        id,
        {
          product,
          cycle,
          covered: false,
          error: 'That release line is not on record.',
          cycles: all.map((row) => row.cycle),
        },
        true,
      );
    }

    // Sorted by how soon each one matters. An ended cycle first, then the
    // nearest date, then the ones with no announced end.
    const today = new Date().toISOString().slice(0, 10);
    const releases = asked
      .map((row) => ({
        cycle: row.cycle,
        supported: !row.ended,
        eol: row.eol,
        daysRemaining: row.eol === null ? null : eolDays(row.eol, today),
        latest: row.latest,
        lts: row.lts,
      }))
      .sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));

    return toolResult(id, {
      product,
      covered: true,
      asOf: bundle.generatedAt,
      // Every supported cycle of the product, not only the ones asked about.
      // Filtered to the question, a query for python 3.9 answered
      // `supportedCycles: []` — true of the row asked for and read as "python
      // has nothing supported", which is the opposite of the answer. This
      // field is the "what do I move to" half and it is useless narrowed.
      supportedCycles: all.filter((row) => !row.ended).map((row) => row.cycle),
      releases,
      source: `https://endoflife.date/${product}`,
      limits: [
        'Dates are published by endoflife.date and republished here unchanged. Nothing is inferred.',
        'A release with no announced end date is reported as having none, which is not the same as being supported indefinitely.',
        'The product list is curated — about two dozen runtimes, databases and frameworks, not the whole catalogue.',
      ],
    });
  }

  if (toolName === 'check_provider') {
    const bundle = await loadJson<IncidentBundle>(origin, '/data/incidents.json');
    if (bundle === null) {
      return toolResult(id, { error: 'The incident record could not be loaded.' }, true);
    }

    const daysRaw = args['days'];
    const days =
      typeof daysRaw === 'number' && Number.isFinite(daysRaw)
        ? Math.min(730, Math.max(1, Math.floor(daysRaw)))
        : 90;

    const since = Date.now() - days * 86_400_000;
    const wanted = asString(args['provider'], 40)?.toLowerCase() ?? null;

    const inWindow = bundle.incidents.filter((row) => Date.parse(row.startedAt) >= since);
    const tracked = [...new Set(bundle.incidents.map((row) => row.provider))].sort();

    if (wanted !== null && !tracked.includes(wanted)) {
      return toolResult(
        id,
        {
          provider: wanted,
          covered: false,
          error: 'Not tracked here, or it has never announced an incident on record.',
          tracked,
        },
        true,
      );
    }

    const scoped = wanted === null ? inWindow : inWindow.filter((row) => row.provider === wanted);
    const counts: Record<string, number> = {};
    for (const row of scoped) counts[row.provider] = (counts[row.provider] ?? 0) + 1;

    return toolResult(id, {
      windowDays: days,
      asOf: bundle.generatedAt,
      ...(wanted === null ? { tracked } : { provider: wanted }),
      total: scoped.length,
      byProvider: Object.fromEntries(
        Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
      incidents: scoped
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, MAX_RESULTS)
        .map((row) => ({
          provider: row.provider,
          title: row.title,
          startedAt: row.startedAt,
          resolved: row.resolved,
          url: row.url,
        })),
      limits: [
        'These are the providers’ own announcements, republished unchanged. Nothing here is measured independently.',
        'A count is how often a provider announced something, not how often it broke. One that publishes every degradation will out-count one that publishes nothing, so a low count is not a good sign on its own.',
        'Unresolved covers both "still going" and "never closed out", which this cannot tell apart.',
        'History only goes back as far as this project has been keeping it, which is shorter than the providers have existed.',
      ],
    });
  }

  if (toolName === 'compare_repositories' || toolName === 'search_repositories') {
    const rows = await loadJson<CompareRow[]>(origin, '/data/compare.json');
    if (rows === null) {
      return toolResult(id, { error: 'The readings could not be loaded.' }, true);
    }

    if (toolName === 'compare_repositories') {
      const a = asString(args['a']);
      const b = asString(args['b']);
      if (a === null || b === null) {
        return toolResult(id, { error: 'a and b are required, as owner/name.' }, true);
      }

      const find = (id_: string): CompareRow | undefined =>
        rows.find((row) => row.id.toLowerCase() === id_.toLowerCase());
      const rowA = find(a);
      const rowB = find(b);

      if (rowA === undefined || rowB === undefined) {
        return toolResult(
          id,
          {
            error: 'Not on the watchlist.',
            missing: [rowA === undefined ? a : null, rowB === undefined ? b : null].filter(Boolean),
            hint: 'Use search_repositories to find what is covered.',
          },
          true,
        );
      }

      return toolResult(id, {
        a: rowA,
        b: rowB,
        note: 'This compares and does not rank. Nothing is totalled across measures that share no unit, and neither side is a winner.',
        limits: LIMITS,
      });
    }

    const query = asString(args['query']);
    if (query === null) return toolResult(id, { error: 'query is required.' }, true);

    const limitRaw = args['limit'];
    const limit =
      typeof limitRaw === 'number' && Number.isFinite(limitRaw)
        ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(limitRaw)))
        : 20;

    const needle = query.toLowerCase();
    const matches = rows.filter((row) => row.id.toLowerCase().includes(needle));

    return toolResult(id, {
      query,
      matched: matches.length,
      returned: Math.min(limit, matches.length),
      repositories: matches.slice(0, limit),
      limits: LIMITS,
    });
  }

  return failure(id, -32602, `Unknown tool: ${toolName || '(none)'}`);
}

/** Preflight, for agents running in a browser. */
export function onRequestOptions(): Response {
  return new Response(null, { status: 204, headers: HEADERS });
}

/** Anything else. GET included — this transport is POST-only by design. */
export function onRequest(): Response {
  return failure(null, -32600, 'POST a JSON-RPC 2.0 request. This server implements MCP.');
}
