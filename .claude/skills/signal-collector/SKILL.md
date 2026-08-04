---
name: signal-collector
description: How the data agent fetches, stores, and schedules GitHub signals for this project — the tiered 4-hourly cadence, conditional requests, live state versus historical ledger, spike baselines, and failure tolerance. Use this skill whenever writing or modifying any collector, the GitHub Actions workflow, the ledger schema, the watchlist, or spike-detection logic; and whenever a task mentions polling, cron, snapshots, deltas, baselines, ETags, or "fetch from GitHub". The cadence and storage split described here are load-bearing.
---

Read `free-tier-guard` first. This skill assumes its limits. Cadence, storage
layout, and API budget are defined there and in Part 2; do not restate them,
follow them.

### Tiered cadence

Not everything runs every four hours. Dependency manifests barely change;
polling them six times a day wastes 2,000 requests for nothing. Pulse handles
repo base and releases. Daily handles manifests, the canonical snapshot, and
pruning. Weekly handles lineage.

### Fetch discipline

**Conditional requests are mandatory.** Store the ETag from every response, send
it as `If-None-Match` next time. Without this the 4-hourly cadence costs roughly
six times what it needs to.

**Budget awareness.** Read `X-RateLimit-Remaining` on every response. Below 500,
stop cleanly, write what was collected, exit successfully with a warning.

**Failure tolerance.** A 404 means deleted, renamed, or private. Mark inactive,
continue, do not crash. Wrap each collector so one failing does not abort the
others — a failed issues collector must leave release and fork output intact.
Retry `5xx` with exponential backoff, three attempts maximum. Never retry `4xx`.

### Spike detection

A spike is a public claim about someone else's repository. The bar is high.

**Baseline.** Trailing 30-day mean of daily fork additions from `history/`,
compared against the most recent rolling 24-hour delta. Rolling, not calendar —
with 4-hourly pulses a genuine 24-hour window is available at any moment, which
detects spikes up to twenty hours sooner.

**Guards:**

- **Minimum absolute floor.** 1 fork to 12 is mathematically 12× and editorially
  meaningless. Require a minimum absolute increase before computing a multiplier.
- **Minimum baseline history.** Under 14 days, collect but do not classify.
- **Two-run confirmation.** `detected` on first observation, `confirmed` only
  after persisting across two consecutive daily snapshots. Only confirmed spikes
  get alarm styling or social posts. This is the cheapest defence against
  bot-driven fork farms, which are the most likely way this project publishes
  something embarrassing.
- **Cap displayed multipliers.** Above ~50×, show a bounded label. Precision at
  that magnitude implies confidence the data does not support.

### Summary state

Every event carries `pending`, `summarised`, or `skipped`. Only events clearing
significance thresholds are marked `pending`. Everything else is `skipped` and
displays raw numbers with no prose.

### Build gate

After collection, hash the built bundle. If it matches the previous run, skip
the Cloudflare deployment and exit. Protects the 500-build quota and keeps
deploy history meaningful.

### Observability

- Write `meta.json` every run: timestamp, requests consumed, repositories
  checked, events detected, collectors that errored.
- Surface the last successful run timestamp in the site header. Stale data must
  be visible to visitors, not hidden.
- Alert on workflow failure. GitHub does not notify by default.
- Commit every run, even when nothing changed.

### Watchlist

A committed file, not generated at runtime. Each entry: repository ID, category,
date added, active status. Changes are commits with reasons — the set of things
being watched is itself an editorial claim and should be reviewable.

Start at ~400. The budget supports several thousand, so growth is an editorial
decision, not a technical one.
