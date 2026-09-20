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
