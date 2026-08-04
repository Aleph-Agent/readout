# Readout

One agent watches ~400 open-source repositories and reports five signals about
them. It runs every four hours on GitHub Actions, commits what it reads to this
repository, and publishes a static site. No server, no database, no API on the
read path.

The commit history of `data/` is the point. It is an audit trail: every reading
is timestamped, append-only, and checkable against GitHub directly.

## What it reports

| Lens | Question |
|---|---|
| Ships | What released a new version? |
| Forks | What is being copied faster than its own baseline? |
| Demand | What are developers asking for, across more than one project? |
| Stack | What dependencies are moving? |
| Lineage | Which models descend from which? *(not collecting yet)* |

## How to read it

**Every comparison is against a repository's own history**, not against other
repositories. "27× baseline" means 27 times what that project normally does, and
the baseline is drawn on the chart so you can see what normal means.

**Confidence is stated, never implied.**

| State | Meaning |
|---|---|
| `forming` | Under 14 days of history. Raw counts only. No multiplier is computed and none is implied. |
| `detected` | Crossed the threshold once. Neutral treatment. |
| `confirmed` | Persisted across two consecutive daily snapshots. |

Only `confirmed` signals are treated as findings. That costs up to a day of
speed and buys the thing that cannot be bought back.

**Generated prose is set in a different typeface from measured values.** Where a
sentence explains a number, every figure in that sentence is checked against the
source record before it is published; if any of them is not in the record, the
sentence is discarded and a templated one is used instead.

## What this does not claim

- The watchlist is **curated and partial**. It is chosen by hand and is not a
  survey of open source. Dependency and demand findings describe the
  repositories being watched, not the ecosystem.
- The data is **not real-time**. Four hours is the floor, and scheduled runs are
  routinely delayed.
- Nothing here predicts anything, and nothing here says a repository is good,
  bad, safe, or unsafe.
- Appearing on the watchlist is an observation, not a relationship. No project
  listed here has endorsed this.

Published findings that turn out to be wrong are superseded by a correction
event carrying the same prominence. Events are never deleted and history is
never rewritten.

## The data

Every bundle the site reads is served as JSON, so any claim can be checked
against the same file the page used.

```
data/
├── live/state.jsonl          Latest reading per repository. Sorted, rewritten each pulse.
├── live/window.jsonl         Timestamped fork samples, for the rolling 24h delta.
├── live/manifests.jsonl      Last-seen dependency set, diffed daily.
├── history/YYYY-MM-DD.jsonl  One immutable snapshot per day.
├── events/YYYY-MM.jsonl      Append-only. Never rewritten, never pruned.
├── summaries.jsonl           Generated prose, keyed by event id.
├── watchlist.jsonl           What is watched, and since when.
└── meta.json                 Last run status.
```

Files are sorted with a fixed key order so a repository that did not change
produces no diff. That is what keeps a repository committed to six times a day
from growing without bound.

## Running it

Node 22.18+ or 24. Types are stripped natively, so there is no build step and no
runtime dependencies.

```sh
npm install          # dev dependencies only: typescript, vitest, fonts
npm test
npm run typecheck

node scripts/pulse.ts --limit=20   # needs GITHUB_PAT
node scripts/daily.ts
node scripts/build.ts              # emits dist/
```

Two scheduled workflows do the rest. `pulse.yml` runs every four hours for
repository base and releases; `daily.yml` writes the canonical snapshot,
classifies spikes, and collects issues and manifests. Both commit every run,
including when nothing changed — scheduled workflows are disabled after 60 days
of repository inactivity, and that commit is what prevents it.

### Configuration

| Secret | Purpose |
|---|---|
| `SIGNAL_GITHUB_PAT` | Fine-grained token, public repository read only. Secret names cannot begin with `GITHUB_`. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Pages: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | |
| `GROQ_API_KEY` | Optional. Without it every reading still publishes, with numbers and no prose. |

## Cost

Cloudflare Pages, GitHub Actions on a public repository, and Groq's free tier.
Static assets and bandwidth on Pages are unlimited, so visitor traffic has no
ceiling. Every remaining limit applies to the build side, which is bounded and
predictable.
