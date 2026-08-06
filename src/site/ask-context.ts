/**
 * The grounding bundle for the ask endpoint.
 *
 * The site has a live answer box, and a live answer box is only defensible if
 * the model answering has nothing to answer from except the record. This builds
 * that record: a compact, self-contained snapshot of everything the instrument
 * currently knows, published as a static file like every other bundle.
 *
 * It is deliberately not the full ledger. The endpoint pays for every byte it
 * sends, the free tier is the budget, and a model handed ten thousand rows
 * answers worse than one handed the hundred that matter. What is here is what a
 * reader could reasonably ask about: the findings on record, the repositories
 * being read, and the instrument's own disclosures about how it measures.
 *
 * Nothing in here is secret — it is a rearrangement of files already served.
 */

import type { EventMetrics, EventRecord } from '../types/events.ts';
import type { IndexBundle } from '../types/bundles.ts';
import type { StripMark } from '../types/bundles.ts';

/**
 * Recent findings only. Older ones stay addressable at their own URLs.
 *
 * The ceiling is not editorial, it is arithmetic. Groq's free tier allows 6,000
 * tokens a minute and counts a single request against it, so a context that
 * exceeds it is not throttled — it is refused outright, with a 413, every time.
 * The first version shipped at 18KB and never answered anything.
 */
const MAX_FINDINGS = 50;

/** Enough of the watchlist to answer "what is being watched" concretely. */
const MAX_REPOS = 30;

/**
 * Hard ceiling on the serialised context, in bytes.
 *
 * Asserted at build time rather than discovered in production. Roughly four
 * bytes to the token, so this is about 3,000 tokens; the system prompt and the
 * answer fit in the remainder with margin. The ledger only grows, and without
 * this the endpoint would go quietly dead again on whichever day it crossed.
 */
export const MAX_CONTEXT_BYTES = 12_000;

export interface AskFinding {
  date: string;
  kind: string;
  repo: string;
  confidence: string;
  /** The sentence already published for this finding, whatever its source. */
  reading: string | null;
  /**
   * Omitted when a reading exists.
   *
   * The published sentence is assembled from these same values and states all
   * of them, so carrying both doubles the cost of the finding to say it twice.
   * When there is no sentence, the metrics are the only record of the numbers
   * and every one of them has to be here — the answer is allowed to quote a
   * figure only if it appears in this file.
   */
  metrics?: EventMetrics;
}

export interface AskCoverage {
  category: string;
  repositories: number;
  measured: number;
  forksAdded: number | null;
  findings: number;
}

export interface AskRepo {
  repo: string;
  category: string;
  language: string | null;
  forks: number;
  stars: number;
  /** Forks gained across the current window. Null while the window is short. */
  added: number | null;
  reading: string;
}

export interface AskContext {
  generatedAt: string;
  instrument: {
    watching: number;
    cadenceHours: number;
    minBaselineDays: number;
    signals: Record<string, { status: string; findings: number; answers: string }>;
    /** What the watchlist is pointed at. Answers "do you watch X" concretely. */
    coverage: AskCoverage[];
    /** Stated so the model can repeat the limits rather than paper over them. */
    limits: string[];
  };
  record: {
    resolvedFindings: number;
    followedByRelease: number;
    followRate: string;
    windowDays: number;
  };
  findings: AskFinding[];
  repositories: AskRepo[];
}

/** What each signal answers, in the same words the page uses. */
const ANSWERS: Record<string, string> = {
  ships: 'What released a new version.',
  forks: 'What is being copied faster than it usually is.',
  demand: 'What developers are asking for in more than one place.',
  stack: 'What dependencies are being added, dropped, or jumped.',
  lineage: 'Which models say they were built on which.',
};

/**
 * The instrument's own caveats, carried into the prompt.
 *
 * A model asked "is React dying" will reach for a trend it does not have. These
 * are the sentences that let it decline accurately instead of vaguely, and they
 * are the same limits the footer already prints.
 */
function limitsOf(index: IndexBundle): string[] {
  return [
    `The watchlist is curated by hand and partial. It is ${index.watchlist.active} repositories chosen deliberately, not a survey of open source, so it cannot support any claim about open source as a whole.`,
    'A category is the reason a repository was added to the watchlist, chosen by hand. It is not a fact about the repository and the set of repositories in a category is not a survey of that field.',
    `Fork activity is compared against each repository's own trailing baseline, never against other repositories, except in the specific case of a fork-outlier finding which names its comparison group and that group's size.`,
    `A repository needs ${index.disclosure.minBaselineDays} days of history before any multiplier is computed. Until then its counts are raw and marked forming, and "forming" means not measured yet rather than measured at zero.`,
    'A finding is a co-occurrence in the record. It is never evidence of cause, and popularity, quality and momentum are not measured here at all.',
    `Readings are taken every ${index.disclosure.cadenceHours} hours. Nothing here is real-time.`,
  ];
}

export function buildAskContext(
  index: IndexBundle,
  findings: readonly EventRecord[],
  strip: readonly StripMark[],
  generatedAt: string,
): AskContext {
  const signals: AskContext['instrument']['signals'] = {};
  for (const [lens, summary] of Object.entries(index.lenses)) {
    signals[lens] = {
      status: summary.status,
      findings: summary.count,
      answers: ANSWERS[lens] ?? '',
    };
  }

  // Newest first: a question about "this week" should meet this week's rows
  // before it runs out of context.
  const recent = [...findings]
    .sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0))
    .slice(0, MAX_FINDINGS)
    .map((event): AskFinding => {
      const base = {
        date: event.detectedAt.slice(0, 10),
        kind: event.kind,
        repo: event.repo,
        confidence: event.confidence,
        reading: event.summary,
      };
      return event.summary === null ? { ...base, metrics: event.metrics } : base;
    });

  const repositories = [...strip]
    .sort((a, b) => (b.delta ?? -1) - (a.delta ?? -1) || b.forks - a.forks)
    .slice(0, MAX_REPOS)
    .map(
      (mark): AskRepo => ({
        repo: mark.name,
        category: mark.category,
        language: mark.language,
        forks: mark.forks,
        stars: mark.stars,
        added: mark.delta,
        reading: mark.state === 'quiet' ? 'nominal' : mark.state,
      }),
    );

  const { resolved, followed, rate, windowDays } = index.scorecard;

  const context: AskContext = {
    generatedAt,
    instrument: {
      watching: index.watchlist.active,
      cadenceHours: index.disclosure.cadenceHours,
      minBaselineDays: index.disclosure.minBaselineDays,
      signals,
      coverage: index.coverage.map((row) => ({
        category: row.category,
        repositories: row.repositories,
        measured: row.measured,
        forksAdded: row.forksAdded,
        findings: row.findings,
      })),
      limits: limitsOf(index),
    },
    record: {
      resolvedFindings: resolved,
      followedByRelease: followed,
      followRate: rate === null ? 'too few resolved findings to state a rate' : `${(rate * 100).toFixed(0)}%`,
      windowDays,
    },
    findings: recent,
    repositories,
  };

  // The budget is bytes, not rows. A count-based cap only holds while the
  // sentences stay the length they are today: fifty findings fit now and would
  // not if the summariser grew wordier, and the failure that produces is a 413
  // on every question rather than anything visible in the build. Findings are
  // dropped oldest-first until it fits, because the newest are what get asked
  // about and every one of them stays addressable at its own URL regardless.
  while (
    context.findings.length > 1 &&
    Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_CONTEXT_BYTES
  ) {
    context.findings.pop();
  }

  return context;
}
