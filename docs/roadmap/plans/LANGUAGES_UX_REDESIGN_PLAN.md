# Languages tab — UX redesign plan (one table, AI-first, inline)

Status: **Proposal — not yet approved, no code written.** Produced per the project owner's
Telegram request, 2026-09-20: "Давай подробнее разберём функционал Languages и редактирование с
помощью ИИ. Сейчас там 2 таблицы, нужно преобразовать в одну и сделать эту функцию максимально
user friendly. Сделай анализ и подготовь предложение по редизайну."

This plan does not authorize implementation. It documents the current state, the concrete
problems found, and a proposed redesign, for the owner to accept, redirect, or reject before any
code changes.

---

## 1. Current state (`src/components/languages-manager.tsx`, ~960 lines)

The tab stacks four independent sections vertically:

1. **"Generate with AI"** (open by default) — a target-language input, a connection selector, and
   a small scrollable checklist (`max-h-48`) of **every** video with a checkbox, used to select
   targets for AI generation. After generating, a review/edit card appears per (video, language)
   pair, each with editable title/description and a "Create Change Set" button.
2. **"Import from XLSX"** (collapsed by default) — export selected/filtered/all to XLSX, upload an
   edited file, preview, create a Change Set.
3. **Change Sets list** — three status sub-tabs ("Все"/"В процессе"/"Одобрено"), a flat list of
   change sets across the whole channel, each expandable into the existing `ChangeSetReview`
   approve/reject UI.
4. **The video table** — thumbnail, title, a language *count* (not which languages), last
   modified, an export checkbox, and a click-to-expand row showing the original title/description
   and every existing locale's title/description. Each expanded row also has a **"Generate with AI
   for this video"** button.

## 2. The two tables, and why they're two tables

Section 1's checklist and section 4's table both list "every video in the channel" — just in two
different visual shapes (a cramped `<label>` list with only title + default language, vs. a rich
table with thumbnail, language count, and an expand action). They exist separately because
section 1 was carried over near-verbatim from the old standalone "AI Localization" tab
(`docs/roadmap/plans/LANGUAGES_TAB_MERGE_PLAN.md`'s L4) without ever being re-derived from
section 4's table, which was the older "Localizations" tab's own list.

**Concrete problems this causes, found by re-reading the component in full:**

- **The "Generate with AI for this video" button doesn't generate in place.** It calls
  `generateForVideo`, which pre-checks that one video in section 1's checklist and
  *scrolls the page up to section 1* (`generateSectionRef.current?.scrollIntoView`). The operator
  loses the context of the row they just opened (its existing locales, original text) to look at
  a completely different, generic-looking section.
- **Three independent selection sets exist simultaneously**, with no shared visual language:
  `selectedVideoIds` (section 1, for AI generation), `exportSelectedIds` (section 4's checkboxes,
  for XLSX export), and implicitly "the one video whose row is expanded" (`expandedVideoId`).
  Checking a box in section 4 does nothing for section 1 and vice versa — an operator who selects
  5 videos to export, then wants to also generate translations for the same 5, has to reselect
  them from scratch in a different list further up the page.
- **Per-video language status is invisible where you'd act on it.** Section 1's checklist shows
  only `defaultLanguage`; you cannot tell which languages are already missing without first going
  to section 4, expanding the row, reading the existing-locales list, closing it, scrolling back
  up to section 1, and finally checking the box.
- **Nothing in the video table shows whether a video already has a pending or approved Change
  Set.** An operator has to separately scan section 3's flat change-set list and manually match a
  change set's `videoId`-less summary card (it shows filename/source/count/date, not which
  video(s) it touches) against the table below by opening `ChangeSetReview` and reading raw
  `videoId` strings in its per-change rows.
- **Four stacked sections means a lot of scrolling for a single, common task** ("this one video is
  missing Spanish — generate it, review it, approve it"): scroll past the AI panel to reach the
  table, expand the row, click "Generate for this video," get scrolled back to the top, generate,
  scroll down past the review cards to the Create-Change-Set button, then scroll further down to
  section 3 to find and approve the resulting change set. The table row itself never reflects any
  of this until a full `fetchOverview` re-run.

## 3. What real YouTube Studio actually does here (for comparison, not literal copying)

Studio does not have a "select N videos, bulk-generate for all of them" AI flow at all — that is
this app's own value-add, not something to remove. What Studio *does* do, and what's worth taking
from it: a single video's translations are managed **inside that video's own details view**, not
in a separate global picker. Selecting a video and acting on its languages happens in the same
place, with no context switch. Our own "Content" tab's new `video-details-panel.tsx`
(BL-031, this session) already established exactly this pattern for the video's core metadata —
this proposal applies the same idea to languages.

## 4. Proposed redesign

**Core change: one table, with everything else happening inline or in a contextual bar — no
separate "pick videos to translate" list.**

### 4.1 The single table

Keep the current table (thumbnail, title) but enrich its columns:

| Video | Languages | Pending | Last modified |
|---|---|---|---|
| thumbnail + title | badge per present language (e.g. `en` `es`) + a muted count of missing (`+2 missing`) instead of a bare number | a small status pill if any change set touches this video (`In review`, `Approved`) or nothing | date |

One selection checkbox per row remains, but it now drives **one** contextual action bar (see 4.2)
instead of being XLSX-export-only.

### 4.2 Contextual bulk-action bar (replaces section 1's checklist entirely)

When ≥1 row is checked, a bar appears above the table: **"3 selected — [Generate with AI ▾]
[Export to XLSX]"**. Clicking "Generate with AI" opens a small popover right there (target
languages input, connection selector, "Generate" button) instead of an always-open, always-visible
top-of-page section that takes space even when nobody is generating anything. This is the direct
replacement for today's section 1 — same capability (bulk multi-video generation), same
underlying API call, just summoned only when needed and scoped to what's actually checked.

### 4.3 Per-video actions move inside the row's own expanded detail

Clicking a row (as today) expands it, showing (as today) the original title/description and
existing locales — **plus, inline, right there:**

- A "Generate with AI" mini-form scoped to just this video (target language input + Generate
  button) — no scrolling, no losing the context of the video you're already looking at. Reuses the
  exact same generation API call as the bulk bar, just pre-scoped to one `videoId`.
- The review/edit step (editable proposed title/description, "Create Change Set") appears directly
  under that same mini-form, in the same expanded row — never in a separate section elsewhere on
  the page.
- If a change set already touches this video, its status and a "Review" link/inline expansion
  appear here too, instead of only in the separate global list.

### 4.4 Change Sets list — kept, demoted to a secondary/cross-video queue

The global sub-tabbed list (Все/В процессе/Одобрено) stays, since it is genuinely useful for a
different task ("go through everything awaiting approval across the whole channel," not
"manage this one video"). Proposed change: label it clearly as a queue/inbox
("Awaiting review across all videos") so it reads as the secondary, bulk-approval surface it is,
now that per-video review can also happen inline in 4.3.

### 4.5 Import/Export XLSX — unchanged

Already collapsed-by-default and clearly secondary; no complaints found here. Export's own
"selected" checkboxes now come from the same single per-row checkbox as everything else (4.1),
removing the last of the three previously-separate selection sets.

## 5. What this does NOT change

- No change to the underlying APIs, Change Set model, or approval workflow — this is a UI-layer
  reorganization of `languages-manager.tsx` (and possibly splitting it into smaller components,
  e.g. a row component with its own local generate/review state) around data the tab already
  fetches.
- No change to write-safety: still zero YouTube writes from this tab; "Одобрено" still never means
  "Опубликовано."
- Does not remove bulk multi-video generation — it relocates the entry point into a contextual bar
  driven by the table's own checkboxes, rather than a separate always-open list.

## 6. Open questions for the owner

1. **Per-video language badges:** show every present language as its own small badge (could get
   wide for a video with 8+ languages), or keep a compact count with the full breakdown only in
   the expanded row (current behavior)? Recommendation: compact count + a green/amber dot for
   complete/missing, full list stays in the expanded detail — keeps the table scannable.
2. **The "Pending" column:** worth the extra API surface (the overview endpoint would need to
   also return, per video, whether any change set currently touches it) — is this valuable enough
   to justify a small backend addition, or is "open the row and see" acceptable? Recommendation:
   worth it, it's the single biggest source of the "which of these did I already do?" confusion
   found in §2.
3. **Bulk-generate popover vs. inline section:** a small popover next to the action bar, or a
   full-width panel that pushes the table down when open (closer to today's behavior, just
   conditional)? Recommendation: popover — keeps the table itself the stable, primary surface.
4. **Scope/sequencing:** this is a substantial rewrite of an already-large component. Proposed
   slices if approved: (a) consolidate to one table + move XLSX export selection onto it
   [low risk, no new API], (b) inline per-video generate/review into the expanded row [reuses
   existing generate API, no new API], (c) contextual bulk-action bar replacing section 1
   [no new API], (d) the "Pending change set" column [needs a small overview-endpoint addition].
   (a)-(c) can ship without any backend change; (d) is the one slice needing new backend work.

No slice above is assigned. Awaiting the owner's direction on which parts (all, some, or a
different combination) to proceed with, per `AGENTS.md` §C.

---

## 7. Addendum, 2026-09-20 (follow-up) — six concrete requirements

The owner reviewed §1-6 above and specified six concrete features over Telegram, quoted here
verbatim (translated) for traceability:

1. The table needs **per-language columns**.
2. Tooling to **add/remove which languages are shown** as columns (a display/tracking concept,
   not a translation action).
3. Each language column must show **whether that video is translated into it yet or not**.
4. The table must be **sortable by clicking column headers**, defaulting to publish-date order.
5. A **recommended-languages** feature (AI) for the channel, with an apply/add button that turns
   the recommendation into tracked language columns.
6. A button to **bulk-add a translation** to every video that doesn't have it yet, for a given
   language.

This section supersedes one specific piece of §4/§6's original recommendation — the "compact
count instead of a grid" call in §6 Q1 — and analyzes the rest as new scope. Superseding a
recommendation this same plan made a few hours earlier is fine (nothing was implemented from it
yet); flagged explicitly so it doesn't read as inconsistency.

### 7.1 Requirement 1 + 3 — per-language ✓/— columns

**What it is:** this is exactly what the *original* pre-redesign "Localizations" table did before
this session's earlier restyle collapsed it to a language *count* (`docs/SYSTEM_MAP.md` §2.8/§2.9d
history) — the redesign undoes that one specific simplification, keeping everything else from §1-6
(one table, inline generation, etc.).

**Implementation:** no new backend needed for the ✓/— data itself — `OverviewRow` already carries
`presentLanguages`/`missingLanguages` per video; today's UI just doesn't render them as columns.
Rendering them as `<col>`s is a pure frontend change to `languages-manager.tsx`'s table markup.

**Risk — table width.** A channel with many tracked languages (say 10+) turns this into a genuinely
wide table. This session's existing horizontal-scroll pattern (`docs/DEVELOPMENT_PLAYBOOK.md` §6.9
rule 6, already applied to this exact table) handles the *mechanical* overflow safely, but it's
worth flagging as a real usability tradeoff, not just a solved problem: past roughly 6-8 language
columns, an operator will be scrolling sideways a lot to compare two videos. No mitigation proposed
beyond horizontal scroll unless the owner wants one (e.g. a "show only tracked languages with at
least one missing video" filter) — flagging, not solving, since it depends on how many languages
real usage ends up tracking.

### 7.2 Requirement 2 — add/remove tracked language columns

**What it is:** today, "which languages exist for this channel" (`Overview.languages`) is *purely
derived* — `src/lib/localization/services.ts`'s `collectChannelLanguages` is just the union of
whatever locales already exist on any video. There is no way to add a language column before any
video has that translation (e.g. to prepare an empty "de" column ready to fill in), and no
persisted "these are the languages we track for this channel" concept at all.

**Implementation:** needs one small, genuinely new, additive backend piece — a
`target_languages_json` (or similar) nullable column on the existing `channels` table
(`SCHEMA_MIGRATIONS` version 6, following the exact `isDuplicateColumnError`-guarded pattern
`docs/DEVELOPMENT_PLAYBOOK.md` §6.3 already documents), plus two small endpoints (or one PUT) to
add/remove a tracked language. `Overview.languages` becomes `(tracked languages) ∪ (languages that
already have at least one real translation)` — a language already translated can never silently
disappear from view even if it's removed from the tracked list, which leads directly into the
one real safety question this requirement raises:

**Risk — "remove a language column" must never be able to delete real translation data.**
AGENTS.md §F: *"Never allow blank spreadsheet cells to imply deletion unless explicitly designed
and confirmed."* The same principle applies here: removing a language from the tracked/displayed
list must be a pure **display preference** — it must never delete, or offer to delete, any
video's actual `existingLocalizations[language]` data, whether local or (eventually, post-Gate-B)
on YouTube. This needs to be stated as an explicit, permanent design invariant before
implementation, not discovered as an edge case afterward. **Recorded as the one real risk in this
requirement; needs the owner's explicit confirmation of this reading before building it** (see
Open Questions below — this is not assumed, it is asked).

### 7.3 Requirement 4 — sortable columns, default by publish date

**What it is:** click a column header to sort by it; unsorted default is publish date.

**Implementation:** the default is already correct today — `listStoredVideosByChannel` orders by
`publishedAt` (newest first) and the overview endpoint doesn't re-sort. Adding a client-side
`sortKey`/`sortDirection` state to `languages-manager.tsx`, applied via `useMemo` alongside the
existing search filter, needs no backend change at all — every field to sort by (title, per-video
`presentLanguages.length`, `lastSyncedAt`, and now each language's own present/missing flag) is
already present in the data the tab already fetches.

**Risk:** none identified — this is a self-contained, low-risk frontend change.

### 7.4 Requirement 5 — AI-recommended languages for the channel

**This is the one requirement that needs a real product decision before implementation, not just
an engineering task.** Two distinct things could be meant by "recommended languages," and they are
**not equally honest to build**:

- **(a) Content-based suggestion:** an LLM looks at the channel's existing titles/descriptions/
  genre and suggests languages commonly associated with that kind of content (e.g. "lo-fi/ambient
  music channels often do well in es/pt/de/ja"). This is buildable today, reusing the existing
  `ai-connections` infrastructure (connection resolution, credential handling, endpoint-security,
  mock-by-default with the same real-cost warning banner the tab already shows for generation).
- **(b) Audience-based recommendation** ("languages your actual viewers are searching in/watching
  from") would require the **YouTube Analytics API** — geography/traffic-source reports — which
  this project has explicitly **not** integrated yet; it is Phase 8 scope
  (`docs/roadmap/plans/PHASE_8_PLAN.md`), gated on its own separate OAuth-scope decision the owner
  has not made. **This app cannot honestly build (b) right now.**

**Risk — misrepresenting (a) as (b).** If a "Recommended languages" button ships without being
extremely clear that it's a content-based heuristic guess, not real audience data, an operator
could reasonably assume YouTube Analytics is already wired in and make real decisions (which
languages to invest translation effort in) based on a much weaker signal than they think they're
getting. **This needs explicit, visible copy in the UI (e.g. "Based on your channel's content —
not your actual audience data, which requires a separate YouTube Analytics connection") every time
it's shown, not just a one-time disclaimer.** This is a product-honesty risk, not a technical one,
and it's the reason this requirement is flagged as needing owner sign-off specifically on scope
(a)-only vs. waiting for Phase 8, rather than being folded into the "low-risk" bucket with 7.1/7.3.

**Implementation (if (a) is approved):** a new, small provider capability — recommending languages
is a different shape of call (channel context in, a list of language codes out) than
`LocalizationProvider`'s existing "generate title/description for one (video, language)" interface,
so it needs its own small interface and mock implementation, wired through the same connection
resolution `ai-connections` already provides (reuse the transport/security/cost-control layer,
add one new task-shaped interface on top — not a parallel AI stack). The "Apply" button then just
calls requirement 2's add-tracked-language endpoint once per recommended language — no new
mutation semantics needed there.

### 7.5 Requirement 6 — bulk "add translation to videos missing this language"

**What it is:** for a given language column, one click selects every video currently missing that
language and routes them into the existing bulk-generate flow (§4.2's contextual action bar).

**Implementation:** this is the lowest-risk of the six — it is a UI convenience wired entirely on
top of data and flows that already exist (`OverviewRow.missingLanguages`, the existing
`selectedVideoIds` set, the existing `POST .../ai-localization/generate` call). No new backend
endpoint, no new provider capability.

**Risk:** none beyond the already-existing bulk-generation cost/quota considerations (unchanged
from today's behavior — selecting more videos just means a larger existing API call, not a new
kind of risk).

### 7.6 Revised phased plan

Ordered by risk/dependency, not necessarily by priority — the owner may reorder:

| Slice | Covers | New backend? | Risk level |
|---|---|---|---|
| **E1** | 7.3 (sortable columns) | No | None |
| **E2** | 7.1 (per-language ✓/— columns) | No | Low (table-width UX tradeoff only) |
| **E3** | 7.5 (bulk "add missing translation" per language) | No | None |
| **E4** | §4.2/§4.3 from the original proposal (contextual bulk bar + inline per-video generate) | No | Low (same as original plan) |
| **E5** | 7.2 (add/remove tracked language columns) | Yes — one additive column + 1-2 endpoints | Medium — **blocked on the owner confirming the "display-only, never deletes data" reading in §7.2 before any code is written** |
| **E6** | 7.4 (AI-recommended languages) | Yes — new small provider interface + endpoint | Medium-high — **blocked on the owner choosing scope (a) (content-based only) vs. waiting for Phase 8, and approving the required UI disclaimer copy** |

E1-E4 have no open product questions and could be assigned together as one slice if the owner
wants to move fast on the parts that are purely engineering. E5 and E6 each have one real,
named decision to make first (data-deletion semantics; analytics-honesty framing) — recorded here
specifically so neither is discovered as a surprise mid-implementation.

### 7.7 Open questions for the owner (this addendum)

1. **§7.2 confirmation:** removing a language from the tracked/displayed columns is a display
   preference only and must never delete, or prompt to delete, any existing translation data
   (local or on YouTube) — confirm this reading before E5 is assigned.
2. **§7.4 scope:** build the content-based ("a") language recommendation now, with mandatory
   disclaimer copy distinguishing it from real audience data — or hold this requirement entirely
   until Phase 8 (YouTube Analytics) makes an audience-based version possible? No middle ground is
   proposed here since a mislabeled heuristic is the actual risk, not the heuristic itself.
3. **Sequencing:** assign E1-E4 as one batch now, and revisit E5/E6 once 1-2 are answered? Or
   assign everything except the two blocked slices, and park E5/E6 until answered?

No slice in this addendum is assigned yet.
