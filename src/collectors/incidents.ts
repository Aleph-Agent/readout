/**
 * Who actually goes down, and how often.
 *
 * Every provider here publishes an incident feed and every one of those feeds
 * forgets. Statuspage carries a few months and then drops the rest, so "how
 * often has this gone down" has no answer anywhere a season later — which is
 * how a provider's reputation ends up being whatever people remember about the
 * last bad week.
 *
 * Nothing is judged and nothing is scored. These are their own announcements,
 * kept after they stopped keeping them, counted and put side by side. A count
 * is not a reliability rating: a provider that publishes every degradation
 * honestly will out-count one that publishes nothing, and the page has to say
 * so wherever the number appears.
 *
 * Deliberately no events. GitHub alone files incidents most weeks, and a
 * finding per incident would bury every other signal in the product under
 * somebody else's operational noise. The value here is the record, not an
 * alert.
 */

import type { IncidentRow } from '../types/incidents.ts';
import { sleep } from '../lib/registries.ts';

const USER_AGENT = 'sighttrue-agent (+https://github.com/sighttrue/sighttrue)';

/**
 * Curated, and every URL verified rather than guessed.
 *
 * Several of these redirect from the obvious hostname — Anthropic's feed lives
 * on status.claude.com, Fly's on status.flyio.net — and following a redirect
 * chain on every run to rediscover that each time is a request spent to learn
 * something already known.
 */
export const PROVIDERS: readonly { slug: string; name: string; feed: string }[] = [
  { slug: 'openai', name: 'OpenAI', feed: 'https://status.openai.com/history.rss' },
  { slug: 'anthropic', name: 'Anthropic', feed: 'https://status.claude.com/history.rss' },
  { slug: 'github', name: 'GitHub', feed: 'https://www.githubstatus.com/history.rss' },
  { slug: 'cloudflare', name: 'Cloudflare', feed: 'https://www.cloudflarestatus.com/history.rss' },
  { slug: 'npm', name: 'npm', feed: 'https://status.npmjs.org/history.rss' },
  { slug: 'vercel', name: 'Vercel', feed: 'https://www.vercel-status.com/history.rss' },
  { slug: 'supabase', name: 'Supabase', feed: 'https://status.supabase.com/history.rss' },
  { slug: 'digitalocean', name: 'DigitalOcean', feed: 'https://status.digitalocean.com/history.rss' },
  { slug: 'fly-io', name: 'Fly.io', feed: 'https://status.flyio.net/history.rss' },
  { slug: 'render', name: 'Render', feed: 'https://status.render.com/history.rss' },
  { slug: 'netlify', name: 'Netlify', feed: 'https://www.netlifystatus.com/history.rss' },
  { slug: 'upstash', name: 'Upstash', feed: 'https://status.upstash.com/history.rss' },
  { slug: 'mongodb', name: 'MongoDB', feed: 'https://status.mongodb.com/history.rss' },
  { slug: 'twilio', name: 'Twilio', feed: 'https://status.twilio.com/history.rss' },
  { slug: 'discord', name: 'Discord', feed: 'https://discordstatus.com/history.rss' },
  { slug: 'sentry', name: 'Sentry', feed: 'https://status.sentry.io/history.rss' },
  { slug: 'groq', name: 'Groq', feed: 'https://groqstatus.com/history.rss' },
  { slug: 'heroku', name: 'Heroku', feed: 'https://status.heroku.com/feed' },
  { slug: 'datadog', name: 'Datadog', feed: 'https://status.datadoghq.com/history.rss' },
  { slug: 'atlassian', name: 'Atlassian', feed: 'https://status.atlassian.com/history.rss' },
];

/**
 * Railway is absent, and Heroku nearly was.
 *
 * Both answer `/history.rss` with 200 and a page of HTML, and both were dropped
 * on that basis — which was the wrong call for one of them. Heroku publishes a
 * perfectly good Atom feed at `/feed`; nobody looked past the URL that failed.
 * Railway's status page is Instatus rather than Statuspage and publishes only
 * its current state, with no incident history in any format, so that one stays
 * a genuine gap in coverage rather than a statement about the service.
 */

/** How long an incident stays on record here after the feed drops it. */
export const RETAIN_DAYS = 730;

export const DELAY_MS = 150;

export interface IncidentClient {
  feed(url: string): Promise<string | null>;
  requests(): number;
}

export function createIncidentClient(): IncidentClient {
  let spent = 0;
  return {
    requests: () => spent,
    async feed(url) {
      spent += 1;
      const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
      if (!response.ok) return null;
      return response.text();
    },
  };
}

/** The five entities XML requires. Statuspage escapes its HTML with these. */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(item: string, name: string): string | null {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item);
  if (match === null) return null;
  const raw = (match[1] as string).replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
  return unescapeXml(raw).replace(/\s+/g, ' ').trim();
}

/**
 * A regex reader rather than a parser, and the trade is stated.
 *
 * Node ships no XML parser and this project ships no dependencies, so the
 * choice is between a hand-written parser and pattern-matching a format that is
 * machine-generated by one product. Statuspage emits every one of these feeds,
 * which makes the shape regular in a way general XML is not.
 *
 * What it gives up: a feed that stops being Statuspage yields no items, which
 * reads as "no incidents" rather than as an error. That is why a provider whose
 * feed parses to nothing keeps its previous rows instead of being emptied.
 */
export function parseFeed(xml: string, provider: string): IncidentRow[] {
  const rows: IncidentRow[] = [];

  // RSS `<item>` and Atom `<entry>` in one pass. Statuspage emits the first and
  // Heroku the second, and the difference is three element names — worth
  // reading rather than dropping a provider over.
  const entries = [
    ...xml.matchAll(/<item>([\s\S]*?)<\/item>/g),
    ...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g),
  ];

  for (const match of entries) {
    const item = match[1] as string;

    const title = tag(item, 'title');
    // Atom puts the URL in an attribute rather than in the element's text.
    const link = tag(item, 'link') ?? /<link[^>]*href="([^"]+)"/.exec(item)?.[1] ?? null;
    const published = tag(item, 'pubDate') ?? tag(item, 'published');
    if (title === null || published === null) continue;

    const at = new Date(published);
    if (Number.isNaN(at.getTime())) continue;

    // RSS calls it a guid and Atom calls it an id. Either is more stable than
    // the link, which providers rewrite when they reorganise their status site
    // — and a changed key would file the same incident a second time.
    const id = tag(item, 'guid') ?? tag(item, 'id') ?? link;
    if (id === null) continue;

    rows.push({
      provider,
      id,
      title,
      startedAt: at.toISOString(),
      // The provider's own word, taken from the update they labelled resolved.
      // Absent, this stays false — which covers both "still going" and "never
      // closed out", and this cannot tell those apart so it claims neither.
      resolved: /<strong>\s*Resolved\s*<\/strong>/i.test(unescapeXml(item)),
      url: link ?? '',
    });
  }

  return rows;
}

export interface IncidentCollectionResult {
  rows: IncidentRow[];
  errors: string[];
  requests: number;
}

export interface IncidentCollectionOptions {
  /** `YYYY-MM-DD` UTC. Anything older than the retention window is dropped. */
  today: string;
  client?: IncidentClient;
  providers?: readonly { slug: string; name: string; feed: string }[];
  delayMs?: number;
  retainDays?: number;
}

export async function collectIncidents(
  previous: readonly IncidentRow[],
  options: IncidentCollectionOptions,
): Promise<IncidentCollectionResult> {
  const client = options.client ?? createIncidentClient();
  const providers = options.providers ?? PROVIDERS;
  const retain = options.retainDays ?? RETAIN_DAYS;
  const errors: string[] = [];

  const cutoff = Date.parse(`${options.today}T00:00:00Z`) - retain * 86_400_000;

  // Keyed by provider and id, so re-reading a feed updates a row rather than
  // duplicating it, and a resolution recorded later replaces the open version.
  const known = new Map(previous.map((row) => [`${row.provider} ${row.id}`, row]));

  for (const [index, provider] of providers.entries()) {
    if (index > 0) await sleep(options.delayMs ?? DELAY_MS);

    let xml: string | null;
    try {
      xml = await client.feed(provider.feed);
    } catch (error) {
      errors.push(
        `incidents ${provider.slug}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (xml === null) {
      errors.push(`incidents ${provider.slug}: feed unavailable`);
      continue;
    }

    const parsed = parseFeed(xml, provider.slug);
    if (parsed.length === 0) {
      // Either a genuinely spotless provider or a feed that stopped being the
      // shape this reads. Both keep what is already on record; only one of them
      // is worth an error, and this cannot tell which.
      errors.push(`incidents ${provider.slug}: no items parsed`);
      continue;
    }

    for (const row of parsed) known.set(`${row.provider} ${row.id}`, row);
  }

  const rows = [...known.values()].filter((row) => Date.parse(row.startedAt) >= cutoff);

  return { rows, errors, requests: client.requests() };
}
