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
  minIssues: number;
  minEngagement: number;
}

export const DEFAULT_DEMAND_THRESHOLDS: DemandThresholds = {
  minRepos: 2,
  minIssues: 3,
  minEngagement: 20,
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

function tokenise(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9.+#-]+/g, ' ')
    .split(' ')
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((word) => word.length >= 3 && word.length <= 24 && !STOPWORDS.has(word));
}

/** Unigrams and adjacent bigrams. Bigrams carry most of the real meaning. */
export function termsOf(title: string): string[] {
  const words = tokenise(title);
  const terms = new Set(words);
  for (let i = 1; i < words.length; i += 1) {
    terms.add(`${words[i - 1] as string} ${words[i] as string}`);
  }
  return [...terms];
}

export function clusterDemand(
  issues: readonly IssueSignal[],
  thresholds: DemandThresholds = DEFAULT_DEMAND_THRESHOLDS,
): DemandCluster[] {
  const byTerm = new Map<string, IssueSignal[]>();

  for (const issue of issues) {
    for (const term of termsOf(issue.title)) {
      const list = byTerm.get(term);
      if (list) list.push(issue);
      else byTerm.set(term, [issue]);
    }
  }

  const clusters: DemandCluster[] = [];

  for (const [term, matched] of byTerm) {
    const repos = [...new Set(matched.map((issue) => issue.repo))].sort();
    if (repos.length < thresholds.minRepos) continue;
    if (matched.length < thresholds.minIssues) continue;

    const engagement = matched.reduce((sum, issue) => sum + issue.reactions + issue.comments, 0);
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
