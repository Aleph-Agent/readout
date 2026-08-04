---
name: free-tier-guard
description: Hard infrastructure ceilings for this project — GitHub API rates, GitHub Actions behaviour, Cloudflare Pages build quotas, Groq limits, and forbidden platforms. Use this skill before choosing any hosting provider, database, scheduler, or LLM provider; before changing polling frequency or the number of watched repositories; before adding any dependency that implies a server; and whenever a task mentions Vercel, Supabase, cron timing, rate limits, deploy counts, or "just upgrade the plan". Every number here was verified against primary sources — treat them as facts, not estimates.
---

### Forbidden platforms

**Vercel — do not deploy to it.** The Hobby plan is restricted to personal,
non-commercial use, and Vercel's own definition of commercial usage includes
accepting donations and any deployment used for the financial gain of anyone who
helped build it. This project promotes a token that earns creator fees.
Deploying here risks suspension without warning. Do not propose Vercel. Do not
propose Vercel Cron. If a task assumes Vercel, correct the task.

**Supabase — never on the read path.** Free projects pause after 7 days of
inactivity, cap the database at 500 MB, and cap egress at 5 GB/month. Crossing
egress returns 402 on every service until upgrade. The pause is survivable; the
egress cap is not, because it scales with traffic. Supabase may be used later
for something genuinely relational and low-traffic. It must never sit between a
visitor and the page they requested.

### GitHub REST API

| Auth method | Limit |
|---|---|
| Unauthenticated | **60/hour** |
| Personal access token | **5,000/hour** |
| Built-in `GITHUB_TOKEN` in Actions | **1,000/hour per repository** |

Rules:

1. **Use a fine-grained personal access token** with public-repository read
   access, stored as a repository secret. Not the built-in Actions token — its
   1,000/hour ceiling is too close to the working budget. Grant nothing beyond
   public read. Never log it.
2. **Never make unauthenticated calls.** 60/hour exhausts in seconds.
3. **Use conditional requests.** Send `If-None-Match` with the stored ETag. A
   `304 Not Modified` does not count against the rate limit. Most watched
   repositories do not change between pulses, so this is the largest single
   saving available.
4. **Read rate-limit headers on every response.** Below 500 remaining, stop the
   run cleanly and write what was collected. A partial run is fine. Tripping a
   secondary rate limit is not — it can restrict the token beyond the current run.
5. **Search API is a separate, smaller bucket** — 30/minute. Use only where the
   core API cannot answer, never in a loop without delay.
6. **Code Search API is capped at 10/minute.** Never build a feature that scans
   GitHub globally. Dependency signals come from reading manifests in the
   existing watchlist.

Verified budget at 400 repositories:

| Collector | Cadence | Calls/run | Calls/day |
|---|---|---|---|
| Repo base | 4-hourly | 400 | 2,400 |
| Releases | 4-hourly | 400 | 2,400 |
| Top issues | daily | 80 | 80 |
| Manifests | daily | 400 | 400 |
| Lineage | weekly | ~50 | ~7 |
| **Total** | | | **~5,290** |

Daily ceiling is 120,000. Uses **~4.4%**. With ETags, far lower. The watchlist
can reach roughly 3,000 repositories before rate limits bind.

### GitHub Actions

- **Public repositories: unlimited minutes.** The agent repository must be
  public.
- Private repositories get 2,000 Linux minutes/month — not enough headroom and
  unnecessary.
- A single job is killed at 6 hours. Set an explicit `timeout-minutes` anyway so
  a hung request cannot burn an hour.

Scheduling behaviour:

1. Scheduled workflows are **delayed 10–30 minutes at peak.** Never promise an
   exact update time in the UI. Display the actual last-run timestamp.
2. **Never schedule on the hour.** `0 */4 * * *` lands in the most congested
   window. Use `17 */4 * * *`.
3. **Scheduled workflows auto-disable after 60 days of repository inactivity.**
   The agent commits every run, so this never fires — but it is load-bearing. If
   commits are ever removed from the run, this failure returns silently.
4. **Failures are not notified.** Build alerting into the workflow.
5. Only the default branch can be scheduled. Always add `workflow_dispatch`.

### Cloudflare

| Service | Free ceiling | Relevance |
|---|---|---|
| Pages — static requests | Unlimited | The read path. No limit. |
| Pages — bandwidth | Unlimited | No limit. |
| **Pages — builds** | **500/month** | **Binding constraint.** |
| Workers | 100,000/day | Barely used. |
| D1 | 5 GB, 5M rows read/day, 100K written/day | Archive only. |
| Workers AI | 10,000 neurons/day | ~15–25 Llama 8B calls. Emergency only. |
| KV | 100,000 reads/day, 1,000 writes/day | Read cap too low for visitors. Not on read path. |
| R2 | 10 GB, 1M writes/mo, 10M reads/mo | Only for large assets. |

**Required optimisation:** hash the built bundle and skip deployment when it
matches the previous run. On quiet days this recovers meaningful build quota.

### LLM providers

**Groq — primary.** Free tier: 30 requests/minute, **6,000 tokens/minute**,
roughly 1,000 requests/day, tracked per model. No card required.

The tokens-per-minute ceiling is the real constraint, not the daily count. At
~1,000 tokens per call that is about six calls per minute, so a pass over ~60
items takes around ten minutes. Fine — the job is not interactive.

**Do not summarise everything.** Only events that clear significance thresholds:

| Event type | Summaries/day |
|---|---|
| Releases worth describing | 20–40 |
| Confirmed fork spikes | 5–15 |
| New demand clusters | ~10 |
| Dependency shifts | ~5 |
| **Total** | **50–70** |

Fits inside the free tier with room. Cost **$0**.

**Never re-summarise.** An item summarised at 04:17 must not be summarised again
at 08:17. Store a summary state flag per item. Without it, the 4-hourly cadence
multiplies LLM usage sixfold and breaks the budget.

Fallbacks in order: Cloudflare Workers AI (10,000 neurons/day, a dozen calls);
then DeepSeek (~70 calls/day is roughly 2M tokens/month, under one dollar).
Never fall back to a provider requiring a card without flagging it first.

### Pre-flight checklist

- [ ] No always-on service, VPS, container, or daemon
- [ ] No database read on the visitor path
- [ ] No LLM call on the visitor path
- [ ] Cadence unchanged, or Pages build maths redone
- [ ] GitHub calls/day recomputed and under 20,000
- [ ] Conditional requests still in use
- [ ] Agent repository still public
- [ ] Run still commits, keeping schedules alive
- [ ] Summary state flags still prevent re-summarisation
- [ ] Nothing added from the forbidden list
