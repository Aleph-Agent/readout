/**
 * Demand clustering.
 *
 * Turns high-engagement open issues into a claim of the form "developers across
 * N watched repositories are asking about X". Pure, so every threshold can be
 * tested on its own.
 *
 * Issue titles are third-party writing. They are read here to derive terms and
 * are never stored or published — what leaves this module is a single word or
 * pair of words, which is the short identifying phrase the attribution rules
 * allow, plus links back to the issues themselves.
 */

export interface IssueSignal {
  repo: string;
  number: number;
  /** Read for term extraction only. Never rendered. */
  title: string;
  url: string;
  reactions: number;
  comments: number;
}

export interface DemandCluster {
  /** One or two words. The only text this produces. */
  term: string;
  /** Distinct repositories the term appeared in, sorted. */
  repos: string[];
  issues: number;
  /** Reactions plus comments across the matching issues. */
  engagement: number;
  /** The single most-engaged issue, as the evidence link. */
  topUrl: string;
  topRepo: string;
}

export interface DemandThresholds {
  /**
   * A cluster confined to one repository is that project's backlog, not a
   * demand signal — and it is the shape issue brigading takes.
   */
  minRepos: number;
  /**
   * Share of sampled repositories a term may appear in before it is treated as
   * background vocabulary rather than a signal.
   *
   * This is the guard the first live run was missing. "support" turned up in 29
   * of 80 repositories with the highest engagement of anything measured, and
   * the detector ranked it first. Being everywhere is evidence a word is common
   * English, not evidence developers are asking for it. Frequency and demand
   * point in opposite directions past a certain spread.
   */
  maxRepoShare: number;
  minIssues: number;
  minEngagement: number;
}

export const DEFAULT_DEMAND_THRESHOLDS: DemandThresholds = {
  minRepos: 2,
  maxRepoShare: 0.15,
  minIssues: 3,
  minEngagement: 60,
};

/**
 * Grammatical filler plus the vocabulary every issue tracker shares. "Support"
 * and "add" are kept: "windows support" and "add streaming" are the shape a
 * real request takes, and bigrams give them their meaning back.
 */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been',
  'before', 'being', 'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does', 'doesn',
  'doing', 'don', 'for', 'from', 'get', 'gets', 'had', 'has', 'have', 'how', 'i', 'if', 'in',
  'into', 'is', 'isn', 'it', 'its', 'just', 'me', 'more', 'my', 'no', 'not', 'of', 'on', 'one',
  'only', 'or', 'other', 'our', 'out', 'over', 'run', 'running', 'should', 'so', 'some', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'too', 'try',
  'up', 'use', 'used', 'using', 'very', 'want', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'why', 'will', 'with', 'without', 'won', 'work', 'working', 'works',
  'would', 'you', 'your',
  // Generic tracker furniture that clusters everything into one useless bucket.
  'bug', 'error', 'feature', 'issue', 'please', 'problem', 'question', 'request',
]);

/**
 * Words that carry no subject on their own.
 *
 * Pairing was not enough by itself: "add support" survived the first pass and
 * says exactly as little as "support" did. A phrase needs at least one word
 * that names something. These are rejected only when *both* halves are in this
 * set, so "cluster autoscaling" and "streaming support" still stand while
 * "cluster failed" and "add support" do not.
 */
const GENERIC = new Set([
  'add', 'added', 'allow', 'break', 'broken', 'build', 'builds', 'change', 'changed', 'changes',
  'check', 'cluster', 'code', 'config', 'crash', 'default', 'disable', 'enable', 'error', 'errors',
  'fail', 'failed', 'failing', 'fails', 'file', 'files', 'fix', 'handle', 'improve', 'incorrect',
  'install', 'installation', 'invalid', 'load', 'management', 'method', 'methods', 'missing',
  'mode', 'new', 'option', 'options', 'output', 'public', 'remove', 'return', 'set', 'setting',
  'settings', 'setup', 'slow', 'support', 'test', 'tests', 'type', 'types', 'update', 'updates',
  'upgrade', 'value', 'values', 'version', 'wrong',
]);

function isGenericPair(term: string): boolean {
  const words = term.split(' ');
  return words.length === 2 && words.every((word) => GENERIC.has(word));
}

function tokenise(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9.+#-]+/g, ' ')
    .split(' ')
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((word) => word.length >= 3 && word.length <= 24 && !STOPWORDS.has(word));
}

/**
 * Adjacent word pairs only.
 *
 * Single words were tried and were a mistake. "streaming support" is a request;
 * "support" is vocabulary, and because a single word accumulates engagement
 * from every context it appears in, it outranks every specific phrase. The
 * first live run produced 141 clusters against a budget of ten, and the top
 * twelve were `failed`, `cluster`, `support`, `allow`, `add`, `test` — none of
 * which is a thing anybody asked for.
 *
 * A pair is the smallest unit that can carry a subject and a verb.
 */
export function termsOf(title: string): string[] {
  const words = tokenise(title);
  const terms = new Set<string>();
  for (let i = 1; i < words.length; i += 1) {
    terms.add(`${words[i - 1] as string} ${words[i] as string}`);
  }
  return [...terms];
}

/**
 * Terms that survived every structural filter, before the engagement bar.
 *
 * Split out so the engagement threshold can be measured against the population
 * it actually judges. `clusterDemand` reports what crossed; this is what was
 * there to cross, and the difference is the only evidence that the bar is
 * reachable — see `lib/calibration.ts`. Shared rather than duplicated, so the
 * two can never drift into measuring different things.
 */
function candidatesOf(
  issues: readonly IssueSignal[],
  thresholds: DemandThresholds,
): { term: string; repos: string[]; matched: IssueSignal[]; engagement: number }[] {
  // Denominator for the spread test: how many repositories were looked at, not
  // how many happened to mention a given term.
  const sampled = new Set(issues.map((issue) => issue.repo)).size;
  const spreadCeiling = Math.max(thresholds.minRepos, Math.floor(sampled * thresholds.maxRepoShare));

  const byTerm = new Map<string, IssueSignal[]>();

  for (const issue of issues) {
    for (const term of termsOf(issue.title)) {
      const list = byTerm.get(term);
      if (list) list.push(issue);
      else byTerm.set(term, [issue]);
    }
  }

  const candidates: { term: string; repos: string[]; matched: IssueSignal[]; engagement: number }[] =
    [];

  for (const [term, matched] of byTerm) {
    if (isGenericPair(term)) continue;

    const repos = [...new Set(matched.map((issue) => issue.repo))].sort();
    if (repos.length < thresholds.minRepos) continue;
    // Too narrow is a backlog. Too broad is a dictionary.
    if (repos.length > spreadCeiling) continue;
    if (matched.length < thresholds.minIssues) continue;

    candidates.push({
      term,
      repos,
      matched,
      engagement: matched.reduce((sum, issue) => sum + issue.reactions + issue.comments, 0),
    });
  }

  return candidates;
}

/**
 * Engagement of every term that reached the engagement bar's gate.
 *
 * The distribution `minEngagement` is judged against. A day where the busiest
 * candidate scored 12 against a bar of 60 is a day this detector could not have
 * fired whatever developers were asking for, and that is worth knowing before
 * thirty of them have passed.
 */
export function demandEngagements(
  issues: readonly IssueSignal[],
  thresholds: DemandThresholds = DEFAULT_DEMAND_THRESHOLDS,
): number[] {
  return candidatesOf(issues, thresholds).map((candidate) => candidate.engagement);
}

export function clusterDemand(
  issues: readonly IssueSignal[],
  thresholds: DemandThresholds = DEFAULT_DEMAND_THRESHOLDS,
): DemandCluster[] {
  const clusters: DemandCluster[] = [];

  for (const { term, repos, matched, engagement } of candidatesOf(issues, thresholds)) {
    if (engagement < thresholds.minEngagement) continue;

    const top = matched.reduce((best, issue) =>
      issue.reactions + issue.comments > best.reactions + best.comments ? issue : best,
    );

    clusters.push({
      term,
      repos,
      issues: matched.length,
      engagement,
      topUrl: top.url,
      topRepo: top.repo,
    });
  }

  // A bigram and the words inside it describe the same demand. Longest first,
  // so "streaming support" is kept and the bare "streaming" it contains is
  // dropped — otherwise every cluster is reported three times.
  //
  // Whole-word containment, not substring: "act" must not be swallowed by
  // "react".
  const ranked = clusters
    .slice()
    .sort(
      (a, b) =>
        b.engagement - a.engagement ||
        b.term.length - a.term.length ||
        (a.term < b.term ? -1 : 1),
    );

  const kept: DemandCluster[] = [];
  for (const cluster of ranked) {
    if (kept.some((other) => other.term.split(' ').includes(cluster.term))) continue;
    kept.push(cluster);
  }

  return kept;
}
