# Readout

**[readout-7pt.pages.dev](https://readout-7pt.pages.dev)** · [your stack](https://readout-7pt.pages.dev/stack) · [compare](https://readout-7pt.pages.dev/compare) · [method](https://readout-7pt.pages.dev/method) · [feed](https://readout-7pt.pages.dev/feed.xml)

## Check your dependencies in CI

```yaml
permissions:
  pull-requests: write   # only needed for the comment

steps:
  - uses: actions/checkout@v4
  - uses: kaitzyy-dev/readout@v1
    with:
      manifest: package.json
      fail-on: archived,relicensed
```

Fails the build when a dependency's repository has been archived or has moved
to a source-available licence, and reports advisories either way. No key, no
account, no service to sign up to — it reads published measurements and talks
to OSV. A network problem is never a finding: if the readings cannot be fetched
the step says so and passes, because a build that breaks when somebody else's
site is down is a build that gets deleted.

On a pull request it also leaves a comment with the findings as a table, and
rewrites that same comment on every push rather than adding another. A red
build tells a reviewer that something is wrong; it does not tell them which
dependency, or what changed about it, without opening the log. Set
`comment: false` to report only in the step summary. A pull request from a fork
gets a read-only token, so the comment is skipped there and the step still
passes.

Also runs against `requirements.txt` and `Cargo.toml`.

## Suggest something to watch

The watchlist is curated and partial, and it was chosen by hand with no method
beyond judgement — its weakest point. [Open an issue](../../issues/new?template=watch-a-repository.yml)
to argue for a repository. Every change to the list is a reviewed commit, so
that issue is where the review happens.

## For coding agents

An MCP server over the same readings, so an agent can answer "is this
dependency healthy" from a measurement taken today rather than from training
data a year old.

```json
{ "mcpServers": { "readout": { "url": "https://readout-7pt.pages.dev/api/mcp" } } }
```

Seven tools: `check_package`, `check_stack`, `check_eol`, `check_provider`,
`compare_repositories`, `search_repositories`, `find_model`. Read-only, no key, no account. Every result carries the
limits of what it can support, because an agent will paste these figures into a
code review and a scorecard quoted without "measures declared practices, not
whether the project is safe" is a claim this project does not make.

One agent watches ~400 open-source repositories and reports five signals about
them. It runs every four hours on GitHub Actions, commits what it reads to this
repository, and publishes a static site. Every page and every bundle is a file;
the single dynamic route is `/api/ask`, and no page depends on it.

The commit history of `data/` is the point. It is an audit trail: every reading
is timestamped, append-only, and checkable against GitHub directly.

## What it reports

| Lens | Question |
|---|---|
| Ships | What released a new version? |
| Forks | What is being copied faster than its own baseline? |
| Demand | What are developers asking for, across more than one project? |
| Stack | What dependencies are moving? |
| Lineage | Which models say they were built on which? |

Whether each detector's threshold is reachable at all is published too, on the
index under Our record. A detector nothing has ever come close to is not a quiet
detector, it is a misconfigured one, and the site says so about itself.

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

### Watchlist maintenance

The watchlist is curated. Deriving it from a search query was tried and produced
a worse list — topic search only finds repositories that tagged themselves, and
sorting by stars ranks tutorials and link collections above infrastructure.
`derive-watchlist.ts` is kept for proposing candidates a curator might have
missed, and because the negative result is worth being able to reproduce.

```sh
node scripts/verify-watchlist.ts   # check every entry against the API
node scripts/retire-watchlist.ts   # mark archived and deleted ones inactive
node scripts/derive-watchlist.ts   # propose candidates, writes nothing
node scripts/derive-packages.ts    # map repositories to packages, writes nothing
```

`derive-packages.ts` fills the `packages` field, which is what lets the agent
ask what a project's downloads are doing rather than only what its repository is
doing. It never maps on a name match: a candidate is proposed, the registry's own
record for that name is fetched, and the mapping is kept only when the registry
points back at this repository. That rule is not decoration — the first version
matched on substring and mapped `angular/angular` to the npm package `angular`,
which belongs to the archived `angular/angular.js`, and would have credited a
dead project's downloads to a live one.

Nothing is ever removed. Retired entries stay on the list with `active: false`,
because deleting one would erase the record that it was watched at all, and the
findings collected while it was still link to it.

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
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | Optional. Without them confirmed findings still publish on the site and in the feed; they are simply not announced. |

Both optional groups are genuinely optional: unset, their steps skip and say so.
Nothing is marked as a failed run, because choosing not to configure something
is not a fault, and a warning that is always on is a warning nobody reads.

## License

MIT. See [LICENSE](LICENSE).

## Cost

Cloudflare Pages, GitHub Actions on a public repository, and Groq's free tier.
Static assets and bandwidth on Pages are unlimited, so visitor traffic has no
ceiling. Every remaining limit applies to the build side, which is bounded and
predictable.
