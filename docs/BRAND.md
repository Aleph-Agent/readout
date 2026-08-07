# Brand

One file. Every name, every piece of copy, every asset spec, and the rules for
all of it. When something needs a description — a profile, a listing, a
directory, a README — it is copied from here rather than written again, because
a product that describes itself differently in five places has no description.

Nothing here is decided by taste alone. Every colour is a measured value from
`src/site/site.css` and every claim is one the published data supports.

---

## Name

**depcanary** · `depcanary.com` · `github.com/depcanary`

A canary in a coal mine is a warning system that fails before you do. That is
the product: it notices a dependency has gone bad — archived, relicensed,
unpatched, unmaintained, out of support — before it costs you anything.

The metaphor survives translation, the word is spellable on the first attempt,
and a bird silhouette is legible at 32 pixels, which is not true of most marks.

**Runner-up:** `depassay.com`. To assay is to test a substance for composition
and purity, which is more precise and less understood. Kept on record in case
the first is ever lost.

**Previously:** Readout. Changing costs a migration — `SITE_ORIGIN`, 331
per-repository feeds, 388 badges, the MCP registry manifest, the README. Cheap
now, expensive in six months.

---

## Copy

Written once. Longer versions add detail; none of them adds a claim.

### One line — 63 characters

> Watches your dependencies and tells you when one goes bad.

### Profile bio — 148 characters, fits X, GitHub, and every directory

> An instrument pointed at open-source dependencies. Archived, relicensed,
> unpatched, out of support — measured every four hours and published.

### Repository description — town square version, 297 characters

> An agent watching ~400 open-source projects and its readers' own
> dependencies. Reports what changed: archived, relicensed, advisories,
> end-of-life, last actual release, bus factor. Every reading is committed
> here, so any figure on the site can be checked against the run that produced
> it.

### The paragraph — for a landing page or a listing that allows one

> Most "is this maintained?" answers read a repository's last push. That is the
> wrong field: a push is what a maintainer does for themselves, a release is
> what reaches the projects depending on them. depcanary reads what actually
> changed — the licence, the archive flag, the advisory count, the end-of-life
> date, the date something last shipped, and how many people write it. Every
> four hours, published as static files, and committed to a public repository
> so any number can be traced to the run that produced it.

### What never goes in the copy

- **"AI-powered."** One endpoint calls a model, and it is fenced so tightly it
  cannot state a number that is not in the record. Leading with it would sell
  the least trustworthy part.
- **"Real-time."** Readings are four-hourly at best and the site says so.
- **"Complete", "all", "every package."** The watchlist is curated and partial.
- **Superlatives with no measurement behind them.** If a claim cannot be
  checked against a published file, it does not get made.

---

## Mark

A canary, drawn as a schematic rather than a mascot.

Think of a bird in a field manual or on a warning plate: one stroke weight, flat
fill, no gradient, no highlight in the eye, no personality. The product's whole
voice is measurement, and a cartoon would be the one thing on screen asking to
be liked.

**Specification**

| | |
|---|---|
| Format | SVG, exported to PNG at each size |
| Sizes | 32, 64, 128, 400, 512 |
| Stroke | Single weight, scaled with the mark, never hairline at small sizes |
| Fill | `--mag-5` on `--ink-000`. One colour, no second. |
| Padding | 12% of the canvas on every side. Avatars get cropped to circles. |

**The 32-pixel test.** If the silhouette is unreadable at 32, the drawing is
wrong — not the size. Legs, beak detail and feather lines all disappear first;
the body and head shape must carry it alone.

---

## Banner

1500 × 500. This is a display case, not a poster.

The signature element is the velocity strip: one narrow vertical mark per
watched repository, ordered consistently, each mark's height driven by that
repository's deviation from its own baseline. Mostly a flat grey comb; during a
storm one mark spikes and turns. It is the only image this project has that
nobody else could produce, because it is drawn from readings rather than from a
design tool.

**Layout**

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ▌ DEPCANARY                                                 │
│    Watches your dependencies and tells you when one goes bad │
│                                                              │
│  ▁▁▂▁▁▃▁▁▁▂▁▁█▁▁▂▁▁▁▁▃▁▁▂▁▁▁▁▁▂▁▁▁▄▁▁▁▂▁▁▁▁▁▂▁▁▁▁▃▁▁▁▁▂▁▁▁  │
│                                                              │
│                       readings every 4h · depcanary.com      │
└──────────────────────────────────────────────────────────────┘
```

Rules: no stock photography, no screenshot of a dashboard, no three-column
feature grid, no floating browser window at an angle. The strip is real data or
it is not on the banner.

**Safe area.** X crops the banner differently on mobile and desktop and overlays
the avatar bottom-left. Nothing that must be read goes in the lower-left 300 ×
200, and nothing goes within 60px of the top or bottom.

---

## Colour

Measured, not chosen by eye. Both themes are tested on every build by
`tests/palette.test.ts`, which fails if a step stops being visible or the ramp
stops being ordered.

| Role | Dark | Light | On its own ground |
|---|---|---|---|
| Ground | `#0a0d07` | `#ffffff` | — |
| Body text | `#c4cab8` | `#2b2f26` | 13.7:1 |
| Strongest | `#e9ecdf` | `#111111` | 18.9:1 |
| Signal | `#ccff00` | `#3d5200` | 8.7:1 |
| Alert | `#f0883e` | `#b32d00` | 6.4:1 |
| Nominal | `#38bdf8` | `#0369a1` | 5.9:1 |

Two signal colours and no third. Nothing is ever encoded by colour alone —
every coloured state also carries a label, a glyph, or a position. The mark may
be coloured; nothing else decorative may be.

---

## Type

| Role | Face | Why |
|---|---|---|
| Numbers | IBM Plex Mono, tabular figures | Every figure in the product. A column of aligned digits reads as instrumentation. |
| Labels and navigation | IBM Plex Sans Condensed | Signage, not voice. |
| Written explanation | IBM Plex Serif | Interpretation must look different from measurement, because it is different. |

Two weights across the whole product. Hierarchy comes from size, case and
colour — never from stacking weights.

---

## Voice

Short declaratives. The number, then what it rests on.

Say what was measured, over what window, against what, and how large the sample
was. A figure without its sample is not a reading. State limits in the same
breath as the claim, not in a footnote — a caveat a reader has to go looking for
is a caveat that was not made.

Never manufacture activity. Most days nothing crosses a threshold, and a quiet
instrument reporting "nothing detected" is working correctly.

**The test for any sentence:** could somebody check it against a published file?
If not, cut it or add the link.

---

## Where this gets used

| Surface | Copy | Asset |
|---|---|---|
| X profile | Profile bio | Mark 400px, banner 1500×500 |
| GitHub org | Profile bio | Mark 400px |
| GitHub repo | Repository description | — |
| MCP registry (`server.json`) | One line, ≤100 chars | — |
| Link previews (`share.png`) | One line | Banner |
| Favicon | — | Mark 32px |

`server.json` caps the description at 100 characters and the registry enforces
it server-side. The one-liner above fits; the bio does not.
