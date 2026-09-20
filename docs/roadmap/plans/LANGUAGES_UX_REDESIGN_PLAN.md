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

### 7.2 Requirement 2 — add/remove tracked language columns (revised, 2026-09-20 follow-up)

**Owner's answer (Telegram, 2026-09-20):** "оценивать как основное применение это 'какие переводы
уже реально существуют' + какие надо добавить. С точки зрения удаления, да можно удалять и с
канала тоже, но это должно требовать несколько этапов подтверждения... + кэш в течение N дней (по
умолчанию 30, чтобы можно было удалённое вернуть)." This is a materially different, much larger
requirement than the original §7.2 draft assumed (display-only). It is a **real deletion
capability** — removing a localization from YouTube itself, not just hiding a column — with a
multi-step confirmation flow and a 30-day (default) recovery window. This revision replaces the
original §7.2 in full.

**This reverses a standing, documented project decision and must be treated as such, not as an
implementation detail.** `docs/PROJECT_SPEC.md` §16 ("XLSX Import") states "Deletion must be an
explicit operation" with no deletion feature ever having been built under that language, and
`docs/ARCHITECTURE.md` §6.14/§296 recorded, in the present tense, that "deletion remains fully
deferred" (that file previously mis-cited the source section as "§8" — corrected to §16 while
resolving this). Per AGENTS.md §A ("identify and report the discrepancy... do not silently rewrite
requirements"), this needed an explicit owner decision on whether `docs/PROJECT_SPEC.md` itself
should be updated to record this reversal. **Resolved — see Open Question 1 in §7.7: the owner
chose to update the spec, and `docs/PROJECT_SPEC.md` §16 now carries the permanent constraint that
came with that decision (multi-step confirmation, a recovery window before any deletion is final).**

**Where the write would live — this is the fact that shapes the whole design.** A real
`videos.update` call that removes a key from the `localizations` map is fundamentally a
**localization** write (it touches exactly the domain `src/lib/localization/`/`src/lib/changesets/`
own, never `src/lib/video-details/`, which is structurally forbidden from touching `localizations`
at all, by design, per AGENTS.md §F). The existing safety-critical write pipeline for localizations
is `src/lib/batches/` — but `src/lib/batches/`'s `WriteExecutor` is **unconditionally barrier-
disabled** (`assertLiveWritesAuthorized()` always throws, Gate B not yet cleared, per
`docs/TECHNICAL_DEBT.md`). **Routing deletion through Batches would make the feature
non-functional today** — the button would exist but could never actually delete anything until
Gate B's full live-validation track is separately completed, which is large, unrelated, unstarted
scope. The only way to ship a *working* delete button today is a **second, standalone live-write
path outside the Batches/Gate-B pipeline** — architecturally a sibling to `src/lib/video-details/`
(reusing the exact same pattern: `write-context.assertWriteChannel` for identity,
`src/lib/backup/` for a pre-write snapshot, its own small audit trail, verification after write),
but for `localizations` instead of `snippet`/`status`. **This needs to be named explicitly, not
discovered later: approving this feature means accepting that a second live write path exists
outside the one pipeline this project has spent most of Phase 5 building safety guarantees for.**
Not a reason to refuse it — a reason the owner should approve it knowingly. **See Open Question 2.**

**Restore is a write, not an undo.** YouTube has no trash/undo for localizations. "Restoring"
within the 30-day window means re-running the exact same kind of write in reverse — reading the
pre-delete backup snapshot and sending it back via `videos.update`. It needs the identical safety
treatment as the delete itself (identity check, its own audit event, post-write verification) —
it is not a cheap local toggle. **See Open Question 3.**

**The 30-day window governs what the UI offers as restorable, not a data-purge schedule.**
`src/lib/backup/`'s snapshot files are already immutable and never deleted by any existing code
path. The correct design is: keep the backup exactly as-is (no new purge job, no new destructive
infrastructure), and have the UI simply stop *surfacing* a "Restore" action once the deletion is
more than 30 days old — the underlying backup file remains, exactly like every other operation's
backup already does, in case it's ever needed later regardless. **See Open Question 3.**

**Backup snapshot kind:** this needs its own variant in the `BackupSnapshot` discriminated union
introduced for `video-details` (`docs/decisions` reasoning in `docs/SYSTEM_MAP.md` §2.9d) — e.g.
`{kind: "localization_deletion", language, before: LocaleMetadata}` — distinct from the existing
`"localization"` kind (which represents a Batches change-set's pre-write baseline for a *set of
changes*, a different shape). Restore reads from this new kind specifically.

**Multi-step confirmation (owner's "несколько этапов подтверждения"):** proposed concretely —
(1) click "Remove" on a language column/cell → (2) a confirmation dialog showing exactly what will
be removed (the language code, its current title/description) → (3) a final explicit confirm
button, styled as destructive (red), separate from the dialog's own dismiss/cancel action. No
"type to confirm" text field proposed unless the owner wants one — the dialog's explicit
before-content display plus a separate final click already matches the spirit of "multiple steps"
without adding friction disproportionate to a recoverable (30-day) action.

**Tracked-languages persistence (unchanged from the original draft):** still needs one small,
additive backend piece — a `target_languages_json` nullable column on `channels`
(`SCHEMA_MIGRATIONS` version 6, `isDuplicateColumnError`-guarded per
`docs/DEVELOPMENT_PLAYBOOK.md` §6.3) plus endpoints to add/remove a *tracked* (not yet necessarily
translated) language. `Overview.languages` remains `(tracked languages) ∪ (languages with at
least one real translation)`, so nothing already translated can vanish from view just because it's
no longer "tracked" — tracking and deletion are two separate actions (untracking hides a column
without touching data; deleting is the new, explicit, multi-step, real write described above).

### 7.3 Requirement 4 — sortable columns, default by publish date

**What it is:** click a column header to sort by it; unsorted default is publish date.

**Implementation:** the default is already correct today — `listStoredVideosByChannel` orders by
`publishedAt` (newest first) and the overview endpoint doesn't re-sort. Adding a client-side
`sortKey`/`sortDirection` state to `languages-manager.tsx`, applied via `useMemo` alongside the
existing search filter, needs no backend change at all — every field to sort by (title, per-video
`presentLanguages.length`, `lastSyncedAt`, and now each language's own present/missing flag) is
already present in the data the tab already fetches.

**Risk:** none identified — this is a self-contained, low-risk frontend change.

### 7.4 Requirement 5 — AI-recommended languages for the channel (resolved, 2026-09-20 follow-up)

**Owner's answer (Telegram, 2026-09-20):** "Пока можно просто пустое поле под рекомендации,
функционал подключим позже когда сделаем интеграцию аналитики. После / как часть фазы 8."
Resolved — this confirms the original write-up's own conclusion (a real, honest recommendation
needs the not-yet-integrated YouTube Analytics API) and picks the simplest safe option: **ship an
empty, clearly-labeled placeholder now** (e.g. "Recommended languages — coming with Analytics
integration, Phase 8"), matching the same pattern the Analytics tab itself already uses for its
own "coming soon" stub. No AI call, no new provider interface, no product-honesty risk to manage
(there is nothing yet to mislabel). **This item moves into the low-risk E1-E4 lane** — it is now
pure static UI, not blocked on anything.

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

### 7.6 Revised phased plan (updated, 2026-09-20 follow-up)

Ordered by risk/dependency, not necessarily by priority — the owner may reorder:

| Slice | Covers | New backend? | Risk level |
|---|---|---|---|
| **E1** | 7.3 (sortable columns) | No | None |
| **E2** | 7.1 (per-language ✓/— columns) | No | Low (table-width UX tradeoff only) |
| **E3** | 7.5 (bulk "add missing translation" per language) | No | None |
| **E4** | §4.2/§4.3 from the original proposal (contextual bulk bar + inline per-video generate) | No | Low (same as original plan) |
| **E4b** | 7.4 (empty "Recommended languages" placeholder, resolved) | No | None |
| **E5** | 7.2 (tracked-language add/remove **+ real deletion with multi-step confirm and 30-day-visible restore**) | Yes — additive `channels` column + endpoints + a new small live-write path (identity/backup/audit/verify) for `localizations`, sibling to `video-details` | **High — a new live-write capability, an already-approved reversal of `PROJECT_SPEC.md` §16's prior deferred-deletion stance, and a second write path outside the Gate-B-barriered Batches pipeline. Blocked only on Open Question 2 (§7.7) now — 1 and 3 are resolved.** |
| **E6** | *(retired — folded into E4b, resolved as a placeholder)* | — | — |

E1-E4b have no open product questions and could be assigned together as one slice if the owner
wants to move fast on the parts that are purely engineering. E5 grew significantly from the
original draft once the owner's actual intent (real deletion, not just hiding a column) became
clear — it now needs three concrete decisions before any code is written, not just a "confirm my
assumption" check.

### 7.7 Open questions for the owner (this addendum, revised) — status after the 2026-09-20 follow-up

1. **Spec reversal — RESOLVED.** Owner: "обновляем сам PROJECT_SPEC. но добавляем что никакое
   удаление не может быть перманентным и сразу... несколько этапов подтверждения... кэш N дней."
   `docs/PROJECT_SPEC.md` §16 updated the same day with this permanent, application-wide
   constraint (not just for this one feature) — see the doc itself. (Correction made while doing
   this: `docs/ARCHITECTURE.md`/`docs/SYSTEM_MAP.md`/`docs/DEVELOPMENT_PLAYBOOK.md` had all
   mis-cited this guidance as "PROJECT_SPEC.md §8" — §8 is "Channel and Account Model," unrelated;
   the real section is §16, "XLSX Import." Fixed in all three files.)
2. **A second live write path — still open.** The owner asked for a plain-language explanation of
   the Gate B blocker rather than answering yet; see the explanation given directly (not repeated
   here) and re-ask this once it's confirmed understood. In short: `src/lib/batches/`'s write
   executor has a hardcoded check that unconditionally refuses every real write, regardless of
   input, until a separate, much larger "Gate B" live-validation task (a real test channel, real
   OAuth, testing the actual write flow end-to-end) is completed and that specific code-level
   barrier is deliberately removed as its own, separately-authorized change. Nothing about this
   feature can change that; routing deletion through Batches today means the delete button would
   always fail with `live_writes_disabled`. Still needs an explicit yes/no on building the
   second, standalone write path instead.
3. **Restore mechanics — RESOLVED**, matching what this plan already proposed: `docs/PROJECT_SPEC.md`
   §16's new text confirms restore is a full write through the same safety model, and that the
   retention window governs what the UI offers as restorable, not the backup file's own lifetime.
4. **Backup retention/purge — deferred, tracked as `docs/TECHNICAL_DEBT.md` RISK-41** per the
   owner's explicit instruction ("удалять нужно, но пока можешь записать в технический долг,
   вернёмся к этому потом"). Not a blocker for E5's initial design — the *current* "backups never
   expire" behavior stays correct and unchanged for now; only a future purge mechanism is deferred.

**Not blocked, asked previously and still open:** whether to start E1-E4b now while E5's remaining
question (#2 above) is being decided.
