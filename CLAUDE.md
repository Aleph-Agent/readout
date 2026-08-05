# Readout — Unified Developer Signal Agent

One agent watches ~400 open-source repositories and reports five signals: Ships
(releases), Forks (abnormal copying), Demand (developer requests), Stack
(dependency migration), Lineage (model descent). One site, one token, not five —
a task implying a split is wrong.

## Non-negotiables

1. **$0 infrastructure.** Cloudflare Pages, GitHub Actions, Groq free tier.
2. **Static-first.** Every page and bundle is a file. One exception, `/api/ask`
   — overruled by the maintainer, scoped in MASTER.md Part 9. No page may
   depend on it.
3. **Public agent repository.** Free Actions minutes; the commit log is the credibility argument.
4. **Never Vercel.** Its free tier forbids commercial use and this is commercial.
5. **No wallet-connect on the site.** Contract address, copy button, nothing more.

Code, comments, commits, copy in English. Conversation in Indonesian.

## Skill routing by phase

| Phase | Load |
|---|---|
| 0 — Scaffold | `free-tier-guard`, `signal-collector` |
| 1 — Collectors | `signal-collector`, `data-integrity` |
| 2 — Build step | `free-tier-guard`, `data-integrity` |
| 3 — Frontend | `frontend-design`, then `instrument-ui` |
| 4 — Profile pages | `instrument-ui`, `data-integrity` |
| 5 — More collectors | `signal-collector`, `data-integrity` |
| 6 — Social | `canvas-design`, `data-integrity` |

If a phase's skills are not loaded, stop and load them before writing code.

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
├── history/YYYY-MM-DD.jsonl  Appended once daily. Immutable.
├── events/YYYY-MM.jsonl      Append-only. Never rewritten.
├── summaries.jsonl           Generated prose by event id. Rewritable.
├── watchlist.jsonl           Committed. Changes are reviewed commits.
└── meta.json                 Last run status.
```

Sorted output with fixed key order keeps git diffs line-level. `window`, `summaries`, and `manifests` were added during the build; MASTER.md Part 2 says why.

Everything else — brief, architecture, skills, library map, build prompts, the
ask endpoint, failure modes — is in `MASTER.md`.
