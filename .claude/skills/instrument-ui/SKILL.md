---
name: instrument-ui
description: The visual system for this project — an instrument, not a dashboard. Covers density, monospaced numerals, colour as signal, motion tied to real values, and the specific patterns that are banned because they read as machine-generated. Use this skill for every frontend task: components, layout, typography, colour, charts, empty states, social cards, and any review of existing UI. Load `frontend-design` first, then this. If a task mentions glassmorphism, neon, gradients, glow, or "make it look modern", this skill overrides the request.
---

Read `frontend-design` first — it is the general craft. This is the brief.
`frontend-design` says the brief's own words win where the brief is specific.
This document is that brief, and it is specific on purpose.

### The thesis

This product is an **instrument**, not a dashboard.

A dashboard summarises for an executive. An instrument reports to an operator who
knows how to read it.

Reference vernacular: a trading terminal, a flight board, a seismograph, an
oscilloscope, a marine radar. Things whose credibility comes from showing raw
measurement and letting the reader draw the conclusion.

The audience is developers who read GitHub daily. They are not impressed by being
told what to think. They are impressed by being shown something they could not
have assembled themselves.

### Banned patterns

Not stylistic preferences. Each is a recognised tell.

- **Glassmorphism.** Frosted translucent panels over dark backgrounds. The single
  most identifiable machine-generated UI pattern in circulation.
- **Neon on near-black.** Cyan or magenta glowing against `#0a0e1a` and
  neighbours. `frontend-design` names this as one of three default AI looks.
- **Gradients as surface.** Permitted only where encoding a continuous quantity,
  and then in one place only.
- **Glow and drop shadow as decoration.** Shadow may indicate elevation. Never
  importance.
- **Emoji in the interface.** No 🚨 on the alert banner. A red rule and a
  typographic label carry more authority.
- **Large rounded cards holding three words.** The shape of an interface with
  nothing to show.
- **Decorative motion.** Anything that moves without encoding a value.
- **Sequential numbering that is not a sequence.** `01 / 02 / 03` on unordered
  things.

### The near-miss to avoid

`frontend-design` also names a third default: broadsheet layouts with hairline
rules, zero border-radius, and dense newspaper columns. The instrument direction
sits uncomfortably close, so the difference must be deliberate.

**An instrument is not a newspaper.** A newspaper's vernacular is editorial:
columns, mastheads, bylines, kickers. An instrument's vernacular is measurement:
readings, deltas, baselines, tolerances, timestamps, units, sample counts,
calibration state.

Whenever a layout decision could go either way, choose the measurement reading.
Label a number with its unit and comparison window, not with a headline. Show the
sample size. Show when it was taken. Show what it is compared against.

If the page could be printed and mistaken for a feature article, it has drifted.

### Density is the flex

Machine-generated interfaces are airy because generation is easier than
selection. Whitespace hides absence of content. This product has 400
repositories, six readings a day, and months of history. Show it.

- Default to tabular rows, not cards. A row per repository, columns per signal.
- Cards are for one thing only: a confirmed event with a written explanation.
- Forty rows on screen is correct. Six cards is not.
- Small type is acceptable in dense regions. Nothing below 11px.
- Whitespace separates groups, not individual items.

### Typography

Three roles, none of them a system default.

**Numerals — monospace, tabular figures.** Every number in the product. Enable
`font-variant-numeric: tabular-nums` explicitly; do not assume it. A column of
aligned digits reads as instrumentation; the same digits proportionally spaced
read as content.

**Interface text — one grotesk.** Labels, headers, navigation, controls.
Restrained. It is signage, not voice.

**Written explanation — one distinct face.** The generated prose. It must look
different from the labels around it, because it *is* different: it is
interpretation, and the reader must see where measurement ends and interpretation
begins. This is the `data-integrity` honesty rule expressed visually.

Two weights only across the product. Hierarchy from size, case, and colour —
never from stacking weights.

### Colour is signal

Monochrome by default. Colour appears only where it carries meaning: one neutral
ramp for everything, one alert colour for confirmed anomalies, one positive
colour for confirmed growth. Two signal colours maximum.

Consequences: navigation is not coloured, headings are not coloured, buttons are
not coloured unless destructive. A logo may be coloured; nothing else decorative
may be.

When most of the page is grey, one red row is unmissable. When everything is
coloured, nothing is.

Never encode meaning in colour alone — every colour-coded state also carries a
label, glyph, or position.

### Motion

Permitted where it encodes a value, nowhere else.

**Permitted:** a pulse whose frequency is driven by actual fork velocity. A
sparkline drawing in reading order. A row highlighting briefly when its value
changes on refresh.

**Not permitted:** entrance animations, staggered fades, parallax, hover lifts,
animated gradients, shimmer skeletons.

Respect `prefers-reduced-motion`. The test: if the animation would look identical
with different data, delete it.

### The signature element

Spend the boldness in one place. Two candidates:

**The velocity strip.** A single horizontal band across the top, one narrow
vertical mark per watched repository, ordered consistently, each mark's height
driven by that repository's deviation from its own baseline. Mostly a flat grey
comb. During a storm, one mark spikes and turns red. The whole watchlist in one
glance, and unmistakably this product.

**The live fee readout.** The Bankr fee endpoint is publicly readable without
authentication, so creator earnings can display live in the header with no login
and no backend. In a market where founders hide revenue, publishing it is a
position competitors cannot copy without also being honest.

Pick one. Two signature elements is zero signature elements.

### Required states

Design these before the happy path.

**Stale data.** Last successful run visible at all times, in UTC, with explicit
age. Past twice the expected cadence, say so plainly in the header.

**Quiet day.** Some days produce no confirmed spikes. The correct response is a
readable statement that the watchlist was checked and nothing crossed the
threshold, with check count and timestamp. A quiet instrument reporting "nothing
detected" is working correctly. Do not manufacture activity to fill space.

**Insufficient history.** Under 14 days of baseline shows raw counts and an
explicit "baseline forming" state. Never a fabricated multiplier.

**Partial run.** When one collector failed, its section says so and the others
render normally. Never a blank page because one signal is missing.

### Charts

Axes labelled with units, always. Baseline drawn explicitly when a comparison is
made — the reader must see what "normal" means. No gridline decoration; gridlines
only where a reader would count them. No area fills unless the area means
something. Sparklines preferred over full charts in dense rows. Y-axis starts at
zero unless truncation is labelled.

### Review checklist

- [ ] Nothing from the banned list is present
- [ ] Could not be mistaken for a feature article
- [ ] Numbers monospaced with tabular figures
- [ ] Generated prose visually distinct from measured values
- [ ] Two signal colours or fewer, no colour-only encoding
- [ ] Every animation driven by data
- [ ] Stale, quiet, insufficient-history, partial-run states exist
- [ ] Last successful run timestamp visible
- [ ] One signature element, not two
- [ ] Keyboard focus visible, reduced motion respected

If a screen passes every item and still feels generic, the problem is density.
Add rows, not decoration.
