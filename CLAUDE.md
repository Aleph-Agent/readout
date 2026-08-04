# Unified Developer Signal Agent — Robinhood Chain

One agent watches ~400 open-source repositories and reports five signals about
them: Ships (releases), Forks (abnormal copying), Demand (what developers ask
for), Stack (dependency migration), Lineage (model descent). One agent, one
site, one token — not five products; if a task implies splitting, the task is wrong.

## Non-negotiables

1. **$0 infrastructure.** Cloudflare Pages, GitHub Actions, Groq free tier.
2. **Static-first.** No database read and no LLM call on the visitor path, ever.
3. **Public agent repository.** Free Actions minutes; the commit log is the credibility argument.
4. **Never Vercel.** Its free tier forbids commercial use and this is commercial.
5. **No wallet-connect on the site.** Contract address, copy button, nothing more.

Code, comments, commits, and product copy in English. Conversation in Indonesian.

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

The `:17` offset avoids peak congestion — never `:00`. 4-hourly is the ceiling
because Cloudflare Pages allows only 500 builds/month.

## Storage layout

```
data/
├── live/state.jsonl          Overwritten each pulse. Sorted by repo id.
├── history/YYYY-MM-DD.jsonl  Appended once daily. Immutable.
├── events/YYYY-MM.jsonl      Append-only. Never rewritten.
├── watchlist.jsonl           Committed. Changes are reviewed commits.
└── meta.json                 Last run status.
```

Sorted output with fixed key order is load-bearing: it keeps git diffs
line-level, so unchanged repositories produce no delta.

Everything else — brief, architecture, full skill text, repository library map,
build prompts, failure modes — is in `MASTER.md`.
