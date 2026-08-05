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

/** Recent findings only. Older ones stay addressable at their own URLs. */
const MAX_FINDINGS = 150;

/** Enough of the watchlist to answer "what is being watched" concretely. */
const MAX_REPOS = 80;

export interface AskFinding {
  date: string;
  kind: string;
  repo: string;
  confidence: string;
  /** The sentence already published for this finding, whatever its source. */
  reading: string | null;
  metrics: EventMetrics;
  url: string;
}

export interface AskRepo {
  repo: string;
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
    .map(
      (event): AskFinding => ({
        date: event.detectedAt.slice(0, 10),
        kind: event.kind,
        repo: event.repo,
        confidence: event.confidence,
        reading: event.summary,
        metrics: event.metrics,
        url: event.evidenceUrl,
      }),
    );

  const repositories = [...strip]
    .sort((a, b) => (b.delta ?? -1) - (a.delta ?? -1) || b.forks - a.forks)
    .slice(0, MAX_REPOS)
    .map(
      (mark): AskRepo => ({
        repo: mark.name,
        language: mark.language,
        forks: mark.forks,
        stars: mark.stars,
        added: mark.delta,
        reading: mark.state === 'quiet' ? 'nominal' : mark.state,
      }),
    );

  const { resolved, followed, rate, windowDays } = index.scorecard;

  return {
    generatedAt,
    instrument: {
      watching: index.watchlist.active,
      cadenceHours: index.disclosure.cadenceHours,
      minBaselineDays: index.disclosure.minBaselineDays,
      signals,
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
}
