# Sighttrue — Unified Developer Signal Agent

One agent watches 388 open-source repositories and takes eleven readings. Five
are the original lenses — Ships (releases), Forks (abnormal copying), Demand
(developer requests), Stack (dependency migration), Lineage (model descent). The
other six never touch GitHub: provider outages, end-of-life dates, model prices,
registry health, packages by real ship date, commit histories for the bus
factor. One site, one token, not five — a task implying a split is wrong.

The site has four doors: Findings, Readings, Your stack, Method. `/stack` is the
only page about the reader — paste a manifest with no account, or sign in with
GitHub to keep the list. Sign-in requests no OAuth scopes.

## Non-negotiables

1. **$0 infrastructure.** Cloudflare Pages, GitHub Actions, Groq free tier.
2. **Static-first.** Every page and bundle is a file. One exception, `/api/ask`
   — overruled by the maintainer, scoped in docs/MASTER.md Part 9. No page may
   depend on it.
3. **Public agent repository.** Free Actions minutes; the commit log is the credibility argument.
4. **Never Vercel.** Its free tier forbids commercial use and this is commercial.
5. **No wallet-connect on the site.** Contract address, copy button, nothing more.

Code, comments, commits, copy in English. Conversation in Indonesian.

## Skill routing by phase

| Work | Load |
|---|---|
| Any collector, workflow, or cadence change | `signal-collector` + `free-tier-guard` |
| Anything the site asserts, any prompt, any label | `data-integrity` |
| Any frontend | `frontend-design`, then `instrument-ui` |
| Social cards | `canvas-design`, `data-integrity` |

If the relevant skills are not loaded, stop and load them before writing code.

## Cadence

| Job | UTC | Cron | Scope |
|---|---|---|---|
| Pulse | every 4h | `17 */4 * * *` | Repo base + releases |
| Daily | 02:17 | `17 2 * * *` | Manifests, snapshot, prune |
| Weekly | Sun 03:17 | `17 3 * * 0` | Lineage refresh |
| Configure Pages | — | dispatch only | Push the Groq key into the Pages project |

The `:17` offset avoids peak congestion. 4-hourly is the ceiling: Pages allows 500 builds/month.

## Storage layout

```
data/
├── live/state.jsonl          Overwritten each pulse. Sorted by repo id.
├── live/window.jsonl         Timestamped fork samples. Rolling 24h delta.
├── live/manifests.jsonl      Last-seen dependency set. Diffed daily.
├── live/adoption.jsonl       Downloads per package. 35-day trend inline.
├── live/lifecycle.jsonl      End-of-life dates per product cycle. Read daily.
├── live/health.jsonl         Scorecard and advisories. Carries forward on a refused read.
├── live/incidents.jsonl      Provider outages, kept after their feeds drop them.
├── live/models.jsonl         Model catalogue and prices. Price moves emit events.
├── live/staleness.jsonl      When each package last actually published.
├── live/contributors.jsonl   Commit concentration. Written weekly.
├── live/trending.jsonl       Rising projects. Appended weekly, never overwritten.
├── live/hiring.jsonl         What employers asked for.
├── live/images.jsonl         Base image weight and rebuild date.
├── live/questions.jsonl      Whether anybody is still asking.
├── live/typosquat.jsonl      Names one edit from a tracked package. Existence only.
├── history/YYYY-MM-DD.jsonl  Appended once daily. Immutable.
├── events/YYYY-MM.jsonl      Append-only. Never rewritten.
├── calibration.jsonl         Append-only. How close everything got to each bar.
├── summaries.jsonl           Generated prose by event id. Rewritable.
├── watchlist.jsonl           Committed. Changes are reviewed commits.
└── meta.json                 Last run status.
```

Sorted output with fixed key order keeps git diffs line-level. Everything below
`state` was added during the build; docs/MASTER.md Parts 2 and 9 say why, along with
the brief, architecture, skills, build prompts, and known failure modes.

**The carry-forward rule.** Every collector that overwrites a whole ledger must
survive a partial read. `lib/carry.ts` decides: a ledger may shrink, it may not
halve in one run, and a run that carried forward says so in its errors. Writing
`rows.length === 0 ? held : rows` is not enough — 88 successful reads out of 388
satisfies it while deleting 300 rows, and no error is raised anywhere.

## Accounts and payment

`migrations/0001_init.sql` is the D1 schema. Money and identity are enforced by
the database, never by the code that calls it — a uniqueness check in
application code is a race condition with good intentions. Two rules:

- Accounts key on GitHub's numeric id, never the login. Logins get renamed and
  reused.
- Nothing is stored in a form that reading the database would reveal: sessions
  and API keys are hashes, and no column anywhere may hold a wallet key.

Run `.github/workflows/peek.yml` to see row counts and prove a real session
still signs somebody in. It prints counts only, never a login or a token.
