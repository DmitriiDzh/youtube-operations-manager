# Languages Tab Merge Plan — fold AI Localization into a Studio-styled Languages tab

Produced 2026-09-20, per the project owner's Telegram follow-up (msg 125) to
`docs/roadmap/plans/STUDIO_PARITY_PLAN.md`: reuse the existing "Localizations" tab (renamed
"Languages"), model its menu/IA on real YouTube Studio's Languages section, layer this app's own
functionality on top, and fold "AI Localization" into it as one workflow rather than a separate
top-level tab. The owner explicitly called this its own planning task ("Это переделка требует
отдельного планирования и проработки") — **this document is that plan. Nothing here is
implemented; it needs its own explicit assignment before any slice below starts, same as every
other roadmap item.**

## 1. What exists today (confirmed by reading the actual components)

- **`src/components/localization-manager.tsx`** (current "Localizations" tab): its own
  independent channel `<select>`; an overview table (video, per-language ✓/— grid, Complete/
  Missing badge, search+status filter); a detail panel per video; XLSX export (selected/
  filtered/all); XLSX import (preview → persist, creates a `ChangeSet`); a Change Set list that
  opens the shared `<ChangeSetReview>` inline. **Bug found in passing:** every Change Set row is
  labeled `{importedFilename ?? "XLSX import"}` — a null `importedFilename` (true for every
  AI-generated Change Set) always shows "XLSX import" even when the set was AI-generated. Worth
  fixing as part of this same work, not a prerequisite.
- **`src/components/ai-localization-panel.tsx`** (current "AI Localization" tab): its own,
  separate, independent channel `<select>`; an editorial-profile editor; a connection picker; a
  generation form (target languages + video multi-select); an editable proposal-review grid; a
  "create Change Set" action. On success it explicitly tells the user: *"Change Set created.
  Approve or reject its changes in the 'Localizations' tab..."* — **the two tabs already have a
  documented "generate here, review there" relationship by design** (`docs/SYSTEM_MAP.md` line
  170), not an accidental split. The editorial-profile editor is itself already precedent for
  "fold a new capability into an existing tab instead of adding a nav item" (`docs/SYSTEM_MAP.md`
  line 149 — added into AI Localization "не новая вкладка").
- **`<ChangeSetReview channelId changeSetId onClose>`** (`change-set-review.tsx`) is **already
  the single, shared review UI for a Change Set regardless of `source`** — AI Localization never
  renders its own review UI, it only creates the Change Set and points at Localizations. **No
  duplicate approve/reject logic exists to reconcile.** This is the main reason this merge is
  smaller than it might sound: the hard part (unifying review) is already done.
- **`ChangeSetSource`** (`src/lib/changesets/contracts.ts:12`) is already `"xlsx_import" |
  "ai_localization"` and persisted — just never displayed anywhere today.
- **Dashboard wiring** (`src/app/dashboard/page.tsx`): two independent `NAV_ITEMS` entries,
  neither component receives `channelId`/`activeChannel` as a prop — each manages its own
  selector. Since today's RISK-02 fix (`docs/decisions/0004-active-channel-read-scoping.md`),
  `GET /api/channels` returns at most one (the active) channel everywhere — **both of these
  independent dropdowns can now only ever show 0-1 option**, making them redundant. Worth
  removing in the same pass (small, unrelated-but-adjacent cleanup): both components should just
  use the single active channel the header already displays, like every other tab.
- **Real Studio's actual Languages page** (`docs/roadmap/plans/STUDIO_PARITY_PLAN.md` §2.2) is
  its own top-level sidebar item, sub-tabs Все/Черновики/Опубликованные, a table of Video /
  language-count / last-modified, and a per-video translation editor. **Studio's own Languages
  page has no bulk-XLSX-import concept and no AI-generation concept at all** — it is pure
  per-video manual translation editing. Reconciling "adopt Studio's menu shape" with "keep our
  XLSX-import + AI-generate + Change-Set-approval workflow" is the one real design tension this
  plan has to resolve (see §3).

## 2. Proposed target IA

One top-level nav tab, **"Languages"** (replacing both "Localizations" and "AI Localization"),
positioned in the sidebar where Studio places it (its own item, not nested under Content or
Analytics — see `STUDIO_PARITY_PLAN.md` §2.2's confirmed real sidebar order).

Inside it, modeled on Studio's own sub-tab shape but carrying our actual data:

- **Landing view = the video table**, Studio-shaped: Video (thumbnail+title) / Languages
  (count, from `existingLocalizationLanguages`, already computed today) / Last modified. Row
  click opens the per-video view. This directly replaces `localization-manager.tsx`'s current
  overview table — same data, Studio's column shape.
- **Sub-tabs above the table** — resolved 2026-09-20 (owner, Telegram msg 131): "Все / В
  процессе / Одобрено", re-mapped from Studio's literal "Все/Черновики/Опубликованные" to
  concepts that actually exist in this app:
  - "Все" (All) — every synced video, as today.
  - "В процессе" (in place of "Черновики"/Drafts) — videos with at least one Change Set not yet
    fully approved/rejected (`change_sets.status` = `in_review` or containing `pending`
    changes) — this is genuinely "work in flight," unlike Studio's "draft not yet published."
  - "Одобрено" (in place of "Опубликованные"/Published) — **never** literally "published to
    YouTube" (Phase 5 live writes remain barrier-disabled, `docs/TECHNICAL_DEBT.md` RISK-09) —
    this reads as "approved locally," never implying a real YouTube write happened.
- **Per-video detail view** (replaces both `localization-manager.tsx`'s detail panel and
  `ai-localization-panel.tsx`'s per-video slice of its multi-select form): existing-locale grid
  (as today), with **AI generation as the primary, default path** — resolved 2026-09-20 (owner,
  Telegram msg 128): *"Мы сразу подразумеваем что наш инструмент/manager использует локализацию
  с помощью агента. Ручная правка возможна, но это только для того чтобы проверить что сделал
  агент и возможно подправить местами."* Concretely:
  - **"Generate with AI"** is the primary action surfaced per video (today's generation form,
    scoped to the one video already selected) — this is the expected, default way a video gets
    localized, not one of two equally-weighted options.
  - Manual editing of a language's title/description is still available, but framed as
    **reviewing and correcting the agent's output**, not as an independent authoring path — i.e.
    it lives inside the same per-video view as an edit affordance on the AI-generated proposal
    (exactly what `ai-localization-panel.tsx`'s existing editable proposal grid already does,
    `toEditable`/`updateTarget`), not as a separate "manual add a language" flow.
  - **"Import from XLSX"** is kept as a secondary, channel-level bulk action (reachable from the
    landing view, not the per-video view) for bulk operations — a bulk correction/review tool
    over already-generated content, not the primary way new languages get added. Whether to
    demote it further (e.g. behind an "Advanced" affordance) or keep it at parity visibility with
    "Generate with AI" on the landing view is left to implementation-time judgment, since the
    owner's direction is clear on *priority*, not on exact visual demotion.
  - Both still funnel into the same `<ChangeSetReview>` — unchanged.
  - §4.2's bulk-vs-per-video AI generation question is **resolved**: keep both — per-video
    "Generate with AI" as the primary path, and the existing channel-wide bulk-generate form
    (today's multi-video checklist) reachable from the landing view for generating many videos'
    worth of proposals in one pass. Neither replaces the other.
- **Editorial profile** — **resolved 2026-09-20** (owner, Telegram msg 135): **not** relocated
  into Languages. The owner's framing: *"Звучит как что-то фундаментальное. И то что редко
  меняется. Давай вынесем это пока в закладку Home, как доп меню."* Moves instead to the future
  Studio-parity **Home** tab (`docs/roadmap/plans/STUDIO_PARITY_PLAN.md` Slice S4), as a
  collapsible panel/sub-menu (open → edit the profile fields → save → close) — same editor
  component that already exists inside `ai-localization-panel.tsx` today, just relocated to a
  different tab, not redesigned. This decouples the editorial-profile relocation from the rest of
  the Languages merge entirely — see `STUDIO_PARITY_PLAN.md`'s updated Slice S4 for detail. §4
  item 3 (editorial profile placement) is retired as a Languages-plan question — it's now a
  Home-tab question with a single settled answer, not an open one.
- **Change Set list** — becomes the "В процессе"/"Одобрено" sub-tab views above, using the
  now-displayed `source` field (fixing the mislabeling bug from §1) to show "AI Generated" vs.
  "XLSX Import" per row.

## 3. Reconciling Studio's shape with our workflow

Studio's Languages page assumes a human manually typing a translation per video, one at a time,
with an immediate "publish" concept. This app's actual workflow is batch-oriented and
approval-gated (import/generate → review → approve → not-yet-live). The plan above keeps
Studio's *navigational skeleton* (top-level tab, table shape, sub-tab-filtered views, per-video
drill-in) while keeping our *workflow* underneath it (import/generate as explicit actions,
Change Set review as the approval gate) — this matches the owner's own framing ("за основу
самого меню берём то как это сделано в Studio и поверх накладываем нужный нам дополнительный
функционал"). It does **not** attempt to make our tool behave like Studio's literal one-video-
at-a-time editor, since that would regress the bulk XLSX/AI workflow this app is actually built
around.

## 4. Open questions

1. ~~Sub-tab semantics: are "Все/В процессе/Одобрено" the right three buckets, and is "Одобрено"
   (never "Опубликовано") the right way to avoid implying a real YouTube write happened?~~
   **Resolved 2026-09-20** (owner, Telegram msg 131, "принимается" in response to this exact
   proposal): use "Все/В процессе/Одобрено" — never "Опубликовано" — for the reason stated above.
2. ~~Where does channel-wide (multi-video) AI generation live once "Generate with AI" also exists
   as a per-video action?~~ **Resolved 2026-09-20** (see §2): keep both, per-video generation is
   the primary path.
3. ~~Editorial profile placement: a settings icon/drawer within Languages, or its own small
   sub-tab?~~ **Resolved 2026-09-20** (owner, Telegram msg 135) — **moves to the Home tab
   instead**, not Languages at all. See §2's updated bullet and
   `docs/roadmap/plans/STUDIO_PARITY_PLAN.md`'s Slice S4.
4. ~~Migration of the "AI Localization" nav item: remove outright, or keep temporarily as a
   redirect/deprecation notice?~~ **Resolved 2026-09-20** (owner, Telegram msg 128): **remove
   outright, immediately** — no transition period, no deprecation notice.
5. **New, resolved-but-needs-a-slice: channel `<select>` removal.** Owner (msg 128): *"Возможно
   нам вообще не нужен дропдаун с выбором каналов, т.к. канал уже изначально выбран."* Confirms
   L1 below (already proposed independently in this plan before this message) — drop both
   components' own channel selectors, use the single active channel like every other tab. No
   longer an open question, just an implementation detail of L1.

## 5. Proposed slices, once assigned

- **L1 (small, low-risk, do first regardless of the rest):** remove both components' now-
  redundant independent channel `<select>`s; use the single active channel like every other tab
  (a direct, uncontroversial consequence of today's RISK-02 fix). Fix the Change Set source
  mislabeling bug (§1) at the same time — same file, same review pass.
- **L2:** restyle the landing view into the Studio-shaped table (Video/Languages/Last modified),
  still showing all videos in one list (no sub-tab filtering yet) — purely visual/column-shape
  change over existing data.
- **L3:** add the "Все/В процессе/Одобрено" sub-tab filtering on top of L2's table.
- **L4:** merge the per-video detail view: existing-locale grid + AI generation as the primary
  action (with inline edit of its proposal, per §2's resolution) + "Import from XLSX" as a
  secondary, channel-level bulk action. Remove the standalone "AI Localization" nav item as part
  of this same slice (§4.4 — resolved, immediate removal, no transition period). **Removing the
  editorial-profile editor from this component happens as part of this same slice** (it moves
  to the Home tab, `STUDIO_PARITY_PLAN.md` Slice S4 — a separate, independently-assignable piece
  of work, not an L-slice of this plan).

All four numbered open questions in §4 are now resolved (2026-09-20). L1-L4 have no remaining
open design questions blocking them; the one remaining implementation-time judgment call (exact
visual prominence of "Import from XLSX" vs. "Generate with AI" on the landing view, §2) does not
block assignment.

L1 has no open questions blocking it and could be assigned independently of the rest — and now
also directly answers the owner's separate channel-dropdown-removal request (§4.5). L2 has no
open questions either (pure column-shape restyle). L3 depends on §4.1 (sub-tab semantics). L4 is
now mostly resolved (AI-as-primary, immediate nav removal) and could be assigned once L1/L2 land.
L5 depends on §4.3 (editorial profile placement).
