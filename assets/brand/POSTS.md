# Posts

The account is **@Sighttruehq**, display name **Sighttrue**. Every asset here
carries both the handle and the domain, and the site publishes the same pair at
/data/official.json — a cloner can forge one surface, not all of them at once.


Six posts, one or two a day. The video first; the cards in the order below.

## The X profile

**Name** Sighttrue &middot; **Handle** @Sighttruehq &middot; **URL** sighttrue.com

**Bio** (153 characters, inside the 160 limit):

> Your dependencies change without telling you. Licences, end-of-life dates,
> outages, releases — measured every four hours and published as files.

No repository count, deliberately. Every earlier draft opened with "an
instrument pointed at 388 open-source repositories", which tells a reader what
our backlog looks like rather than what they get, and reads as a GitHub summary
in the one line where that impression is hardest to undo. The count was in the
banner footer too and is gone from there for the same reason — a reader takes
the whole image at once, so rewriting the headline while leaving the number
underneath it achieved nothing.

## Voice

No adjectives, no emoji, no "excited to announce". The whole argument of this
product is that its figures can be checked, and a post that opens with
"powerful" or "game-changing" contradicts it on the first line — a developer
reading it has already decided what this is before reaching the number.

Every post is the same shape: **name the thing nobody has, then give the figure
that proves this one does.** The complaint comes before the claim, because the
complaint is what makes somebody recognise their own problem.

Figures below match the cards, which are generated from `dist/data/index.json`.
If a post is written more than a few days after the card, regenerate the card
and update the number here — a caption that disagrees with its own image is the
fastest way to lose the only thing this product is selling.

---

## 1 — The film

Longer than the rest on purpose. It is the first post on an account with no
followers, so it has to do three jobs the others can skip: make somebody
recognise the problem, name the thing, and say what it costs to try.

> Every dependency you ship is changing while you are not looking.
>
> A licence quietly becomes source-available, and your legal team finds out
> during due diligence. A runtime drops out of support, and you hear it from an
> auditor. A package with a busy commit graph has not actually published a
> release in fourteen months.
>
> None of that is in your lockfile. Nobody emails you about any of it.
>
> Sighttrue watches all of it and publishes what it finds — licence changes,
> end-of-life dates, provider outages, real publish dates, advisories, and how
> many people a project would survive losing.
>
> Every figure is written to a file and committed, so any of them can be traced
> back to the run that produced it. There is no chart here you have to take on
> faith.
>
> Free, no account, nothing to install. Paste a package.json, requirements.txt
> or Cargo.toml and read your own stack — it never leaves your browser.
>
> sighttrue.com

*Attach `film.mp4`.*

The structure is deliberate. Three losses first, each specific enough that a
reader checks their own project while reading. Then the line that names what is
missing — not in the lockfile, nobody emails you — because that is the gap the
product fills. Only then the product.

The auditability line sits fourth, not first. It is the reason to trust this and
a terrible opening: a post that leads with verifiable figures is answering an
objection the reader has not made yet.

No repository count, and no adjectives. The count describes our backlog rather
than what the reader gets, and a developer who has read a thousand launch posts
has already discounted the one that opens with "powerful".

## 2 — Outages

> Your provider's status page deletes its own history.
>
> Ask how often it actually went down last year and nobody has the record —
> including them.
>
> 441 incidents across 20 providers, kept after the feeds dropped them.
>
> sighttrue.com/incidents

*Attach `post-1-incidents.png`.*

---

## 3 — End of life

> End-of-life dates are published years in advance and watched by almost nobody.
>
> Most teams learn their runtime went unsupported when an auditor tells them.
>
> 518 release lines on the clock, read every day.
>
> sighttrue.com/stack

*Attach `post-2-eol.png`.*

---

## 4 — Bus factor

> Every project health signal measures activity. Not one of them measures how
> many people the project would survive losing.
>
> 387 commit histories, read for who actually writes the code.
>
> sighttrue.com/ecosystem

*Attach `post-3-busfactor.png`.*

---

## 5 — Shipped

> A green commit graph is what a maintainer does for themselves. A release is
> what reaches you.
>
> They are not the same date, and it is the first one that ends up on the badge.
>
> 247 packages, by real publish date from the registry.
>
> sighttrue.com/ecosystem

*Attach `post-4-staleness.png`.*

---

## 6 — Your stack

> Paste your package.json.
>
> Every dependency checked for advisories, licence changes, archived
> repositories and how long since anything actually shipped.
>
> No account, nothing installed, and the manifest never leaves your browser.
>
> sighttrue.com/stack

*Attach `post-5-yourstack.png`.*

---

## If somebody asks how it works

> Everything it reads is committed to a public repository, so the history is the
> audit trail — every reading timestamped and checkable against the source
> directly. It also publishes whether its own detectors have ever been reachable,
> because a detector nothing has crossed is a broken one, not a quiet one.
>
> github.com/sighttrue/sighttrue

## If somebody accuses you of being a clone, or you find one

> The only official channels are listed on the site itself, at the bottom of
> every page, and published as a file: sighttrue.com/data/official.json
>
> Site sighttrue.com · X @Sighttruehq · Code github.com/sighttrue/sighttrue
>
> Anything else is not us.

Do not argue past that. The list is served from a domain nobody else can publish
from, which is the whole of the proof; a longer reply just gives an impersonator
a thread to appear in.

## If somebody asks what it costs

Nothing yet, and say so plainly. The paid tier is not live and promising a price
before it exists is the one claim on this account that could not be checked.
