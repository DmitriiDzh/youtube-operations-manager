# Week template replaces slot approval (BL-267, ADR 0073)

Owner: 2026-11-16, Producer PRD-REQ-0195 part A; owner msgs to the developer 4569 / 4575 (no slot approval at all, the owner
sets up and edits a week template, Media review stays), 4572 (screens), 4620 (the Producer moves a slot to another week keeping its
id). Template values from the owner via the Producer: TG 2376/2377 (WWE), TG 2238 (Tropico), Japan a draft. Factory contract:
the Operator's ADR-0003 draft (`factory_publishing_template_get`, `week-template/1`); bundle 2.5.46 pins with this work.

Status: **Proposed** (plan + ADR 0073 only, no code). The design needs the owner's answers in §7 and his wording for AGENTS.md §F
(ADR 0073 §"Proposed AGENTS.md §F text") before stage 1. Part B shipped as BL-265 (ADR 0072), part C as BL-264. **BL-266 is
reserved for the «Видео» tab redesign** (not in this plan).

## 1. Goal

- **A1.** The owner stops approving slots. Per channel he sets up a **week template** (which kinds of video come out on which
  weekday at which time), edits it himself in the Web UI, or accepts / edits / rejects a template the Producer proposes.
- **A2.** The derived rule: a slot's date reaches YouTube when the slot **matches the approved template** and its package's
  **media is owner-approved** in Media review (BL-257/265 gate, on the channels that have it). Nothing else of the upload safety
  changes.
- **A3.** A slot that does not match the template stays undated and is marked «не по шаблону». The owner can still act on it, one
  slot at a time, explicitly.
- **A4.** Screens: «Сборка недели» and «Календарь» go away. The plan gets two views, «Неделя» and «Месяц», plus a «Шаблон
  недели» editor. Every action that changes a date shows the exact change and asks for confirmation; no hidden bulk action (the
  owner's misfire on 2026-11-16: three slots approved at once, then two Shorts retimed to the wrong day).
- **A5.** The owner and the Producer can move a slot to **another week**, keeping its slot id, also when its video is already
  uploaded. The package↔slot link (manifest `slotId`) and the media review stay.

## 2. Current behaviour (dev `197ed499`)

| Where | What it does today | Why it changes |
|---|---|---|
| `src/lib/publishing-plans/model.ts` `slotViewOf`, `standingPackageApprovalOf`, `fingerprintCovers` | A slot is `approved` only through an owner decision whose hash names the slot content plus the package fingerprint `[video, manifestSha256, videoId]` (ADR 0062). | A1: template match replaces the per-slot decision as the normal path. |
| `services.ts` `slotDecisions` (l. 576) | The uploads' single source: `approved {publishAt, package}` / `vetoed` / `pending`. Consumed by `auto-upload.ts` l. 148, `upload-runner.ts` l. 559 and l. 839–846, `plan-schedule.ts` `decisionForRow`. | The one place the new rule plugs in (§3.4). |
| `slot-decision.ts` `approvalNamesUpload` | An approval dates an upload only when its manifest SHA-256 (and video id) match. | After BL-265 a packaging-only re-package changes the manifest hash; a template date must bind to the media / video id (§3.4). |
| `plan-schedule.ts` `desiredDate`, `change()` | `desiredDate` (l. 92–105) compares the slot's approved time with `row.publishAt` (the date this row last wrote), not with YouTube's current date; `change()` then writes the wanted date over whatever YouTube has. | **Narrow risk today:** a hand-set Studio date is left alone while the slot's approval stays the same; it is overwritten only when a slot approval with a different time appears (re-approval or retime), or removed by a veto. A public video is refused by `change()` anyway (V11 is now public). §3.5 (stage 1) closes the gap. |
| `services.ts` `save` (l. 140) | Refuses `slot_id_in_other_week`, `outside_week`; `slot_approved` / `unlocked` rules for approved slots. | A5 (move tool); a dated slot must not be re-timed by the Operator/worker (§3.7). |
| `services.ts` `retime` (l. 460, ADR 0051 Am. 1) | Owner moves a slot within its week; refuses `outside_week`; `approve` flag. | A5: across weeks; `approve` is replaced by the template rule / explicit date (§3.6). |
| `services.ts` `decideLocked` | Approve the week (many slots) or one slot; ADR 0060 §4: approving a replacing slot vetoes the replaced one. | A4: no bulk. Template dates have no owner event, so the implied veto needs a rule (§3.8). |
| `approvalStage` (ADR 0062 §1) | `packaged` (default) / `slot`, switch «Одобрять пустые слоты». | Retired (§3.8). |
| `socialSlotStates` + `src/composition/cross-posting-plan.ts` | Cross-posts go out for slots with a standing package approval, bound to its manifest SHA-256 (ADR 0068 Am. 1). | A template date must not silently become a social approval (§3.8). |
| `src/app/(app)/content/layout.tsx` | Tabs «Видео», «Публикация», «План недели» (+ `WeeklyBuildCard` «Сборка недели» below it), «Календарь» (`publishing-calendar.tsx`), «Трансляции». | A4. |
| `weekly-plan-panel.tsx` / `weekly-plan-model.ts` | «Всю неделю / По одному», «Одобрить все готовые», per-slot approve, «Изменить время». | A4 (§3.9). |
| Producer endpoint (`src/mcp/producer-tools.ts`) | No plan tool at all. | A5 needs a plan read + move tool; A1 a template propose tool (§3.10). |

## 3. Design

### 3.1 Where the template lives (AGENTS.md §M) and how it syncs

- **Module:** the template is part of `src/lib/publishing-plans/` (new `template.ts`: validation and the pure matcher; services
  for the owner and the agents). Reason: the rule is about the plan's own slots, `slotDecisions` must read slots and template in
  one consistent snapshot, and a separate feature module would only re-read the plan. The module still never imports `publishing`;
  the package facts the matcher needs (duration, video code) come through the existing `progress` port (`PlanSlotPackage` already
  carries `durationSeconds`; `video`).
- **Independence:** template missing, unreadable or withdrawn → no slot is dated by the template (fail closed). The plan, the
  explicit owner date (§3.6), vetoes, uploads without a date and the rest of Content keep working.
- **Storage:** the same sync family `publishing_plans` (no 20th family, no new Syncthing folder), two new root maps in the channel's
  Automerge document:
  - `templateVersions` by version id: **whole immutable records** `{ id, format: "week-template/1", days, horizonWeeks,
    displayTimeZone?, contentHash, by: owner|producer, device, at, seq, basedOn? }`. A version is never edited; an edit is a new
    version. An Automerge merge therefore can never produce a template nobody wrote.
  - `templateDecisions` by id: `{ id, versionId, contentHash, kind: approved|rejected|withdrawn, by: "owner", device, at, seq }`.
    **The template in force** = the version named by the newest (by `seq`, `at`, `id`) owner `approved`/`withdrawn` decision,
    when that is `approved` and the version's recomputed `contentHash` equals the decision's. An owner edit writes his version and
    its `approved` decision in one change.
  - The two maps do not exist in the genesis. Two computers creating the first entry at once would conflict on the root key, so
    the reader merges the entries of every conflicting value (`Automerge.getConflicts`) — AC-WT-05 proves both versions survive.
  - An older build ignores both maps (it keeps showing per-slot approval and never dates by template; the upload computer is the
    Mac, ADR 0046 §8). Both computers update together (risk §10).

### 3.2 The contract `week-template/1` (Producer proposal + Operator ADR-0003 draft, reconciled)

```json
{
  "format": "week-template/1",
  "channelId": "UC…",
  "horizonWeeks": 2,
  "displayTimeZone": "Asia/Tokyo",
  "days": {
    "mon": [{ "kind": "long", "publishTimeUtc": "15:00" }, { "kind": "short", "publishTimeUtc": "12:00" }],
    "fri": [{ "kind": "long", "hours": 8, "publishTimeUtc": "12:00" }]
  }
}
```

- `days`: keys `mon`..`sun`, each a list (absent = no release that day), at most 6 entries a day.
- Entry: `kind` `long` | `short`; `hours` optional, only with `long`, 0.25–12 in steps of 0.25; `publishTimeUtc` `HH:MM`, minutes
  a multiple of 5. Two entries of one day with the same `publishTimeUtc` and `kind` must differ in `hours` (else
  `template_duplicate_entry`).
- **Times and weekdays are UTC** (proposal; §7 P1). The owner's values are given in Z, and UTC has no summer time, so a template
  never drifts. The weekday is the UTC weekday of the slot's instant. `displayTimeZone` (the Producer's `timezone`) only sets how
  the screen shows the times; it is not used for matching.
- `horizonWeeks` (1–8): how far ahead the factory plans. Informational for the factory; YTM does not use it to date (§7 P1).
- `channelId` must be the document's channel. Unknown fields are refused (strict).

**Match (pure, `template.ts`).** A slot matches entry E of the template in force when:
1. weekday(slot instant, UTC) = E's day and the slot instant's UTC `HH:MM` = `E.publishTimeUtc` exactly (no tolerance);
2. the slot's package exists and its kind matches: **short** = `durationSeconds ≤ 180`; **long** = `> 180`. A code `S<n>` (BL-263)
   with a duration over 180 s matches nothing (`template_kind_unclear`);
3. with `E.hours`: `|durationSeconds − hours × 3600| ≤ 10 %` of `hours × 3600` (3 h: 9720–11880 s; 8 h: 25920–31680 s); without
   `hours`: any long video;
4. **one slot per position.** A position is (UTC date, entry index). Two or more live slots matching one position → none of them
   matches (`template_position_ambiguous`, shown on both). Fail closed.

A slot without a package yet can be "on a template time" (rule 1 only); the screen shows «по шаблону · ждёт видео», and no date is
possible until rules 2–3 hold.

### 3.3 Template changes

- **Proposal** (Producer, §3.10): a new version with `by: producer` and no decision. The screen shows «Продюсер предложил шаблон»
  with a per-day diff against the template in force; the owner accepts it (an `approved` decision naming it), rejects it, or opens
  it in the editor (his edit is a new version `basedOn` it).
- **Owner edit:** the editor shows the per-day diff and the effect on the plan's slots from now to the end of the latest planned
  week (N slots will get a date, M become «не по шаблону», whose dates stay). «Применить шаблон» confirms. One version + one
  decision, audited (`publishing_plan.template_approved`), nudges the Producer's Inbox writer (`REVIEW-DECISION-template-<id>.md`).
- **Withdraw** («Даты по шаблону» toggle off): a `withdrawn` decision; nothing is dated by the template until he approves one again.
- **Never retroactive on YouTube:** a template change gives first dates only. A date already on YouTube is never removed or
  moved because the template changed (a slot no longer matching shows «не по шаблону · дата стоит», and the owner may veto it).

### 3.4 The date rule (`slotDecisions`)

`slotDecisions` returns `approved` for a slot when it is not vetoed, not released, its id is unique in the channel, and either:
- **template:** it matches the template in force (§3.2), its package is ready (no blocking problem, which includes the BL-257 gate
  for a package not yet uploaded) or uploaded, and **on a channel with the review gate on**, the package's media key `(video,
  sha256, sizeBytes)` has the owner's standing `approved` media decision — also when the package is uploaded (§7 O3 for videos
  uploaded before the gate). On a channel with the gate off, a ready or uploaded package suffices (§7 O1); or
- **explicit owner date:** a standing owner `approved` decision covering the slot's current package (ADR 0062's rule, §3.6), with
  the media binding below.

**Where the media condition comes from.** `publishing-plans` never imports `package-reviews` or `publishing` (§M). The composition
module `src/lib/publishing-plan-progress/` (already the `progress` port) adds to `PlanSlotProgress.package` the manifest's video
`sha256` + `sizeBytes` and `mediaReview: "approved" | "pending" | "returned" | "not_required" | "unreadable"`, computed with
`package-reviews`' own `standingDecision` for **every** package, uploaded ones included (the scan's gate covers only packages not
yet uploaded). `unreadable` (review document unreadable) and an absent field count as not approved on a gated channel (fail
closed, AC-WT-41).

`SlotDecision` (`slot-decision.ts`, restated per §M) gains `source: "template" | "owner"` and `media: { video, videoSha256,
sizeBytes, videoId|null }`. `approvalNamesUpload` compares the media key (or the video id once uploaded), so a packaging-only
re-package (BL-265) keeps the date. **Explicit owner dates bind to the media too** (the slot-approval leftover of MEDIA_GATE_PLAN §6
Q1): a new explicit decision's fingerprint gains `videoSha256` + `sizeBytes` (additive; an older build ignores them and keeps the
stricter manifest rule); a decision without them (made before this build) keeps the manifest rule (AC-WT-42). `vetoed` and
`pending` are unchanged; a veto always wins.

Consumers (no new path, only the decision's source widens): the automatic upload's queue date (`auto-upload.ts`), the Producer's
queue add (ADR 0059 §4), the runner's re-check before start and before the date step, the plan-schedule pass, cross-posting
(§3.8).

### 3.5 Dates set elsewhere are never moved (owned-date rule; stage 1 of the branch)

The plan acts on a YouTube date only when it is **this computer's own**: the upload row's `publishAt`, as verified by the runner's
date step or the last `planSync`, equals YouTube's current date (read just before, as `change()` already does).
- YouTube has no date → the plan may give a **first date** (the row's checks passed, > 15 min ahead, as today).
- YouTube's date = the row's own date → the plan may **move** it (a slot moved by the owner or the Producer, §3.7) or **remove** it
  (veto).
- YouTube's date ≠ the row's own date (set in Studio, in «Видео», by the other computer) → **foreign date**: never moved, never
  removed; recorded once as `planSync.result: "foreign_date"` and shown on the slot as «дата задана вручную: …». This also covers
  V11/V18. It applies to every source, explicit approvals included, and is independent of the template.

**Motivation and timing.** `desiredDate` compares the slot's approved time with `row.publishAt` — the date this row last wrote —
not with YouTube's current date. So today a date set by hand in Studio is **not** overwritten on the next pass while the slot's
approval stays the same. It is overwritten only when a slot approval with a different time appears (a re-approval or a retime:
`change()` then writes over whatever YouTube has), and removed when a veto lands. A video already public is refused by `change()`
(V11 is now public). Under the template, new time sources appear (a template match, a move by the Producer), so the plan must check
YouTube's actual date itself. The rule goes live with the branch's one merge (AGENTS.md §K.1); stage 1 stays. No early merge is
needed (§7 O11).

### 3.6 Slots off the template, and the owner's explicit actions

A slot that does not match (or is ambiguous, or has an unclear kind) is «не по шаблону»: no date from the template; an upload of
its ready package is still private without a date (ADR 0046). The owner acts on **one slot at a time**, in its details row, each
behind a confirm dialog (our `ConfirmDialog`) that states the exact change:
- **«Перенести на время шаблона»**: pick one free template position (list of the next free positions of its kind); a retime (§3.7)
  after which the template rule dates it;
- **«Дать дату вне шаблона»**: writes today's `approved` decision (with the package fingerprint, packaged rule) for that one slot =
  `source: "owner"`. Old builds understand it. Not offered for a slot waiting for its package or media review;
- **«Снять» / «Вернуть»** (veto / restore), unchanged.

The decide route accepts `approve` with exactly one slot (the week-approve and «Одобрить все готовые» go away, AC-WT-26).

### 3.7 Moving a slot (owner and Producer), also to another week

- **One change** in the Automerge document: delete `<oldWeek>:<slotId>`, put `<newWeek>:<slotId>` with the same id, `createdAt`,
  length, note and `replacesSlotId`, `updatedBy` the mover, and `movedFrom: { weekStart, publishAt, at, by }`. The target plan is
  created when absent, with the source plan's time zone. The package's manifest `slotId` and the upload row's `slot_id` stay, so the
  package, its media review and the upload row follow the slot by id.
- **Decisions follow by slot id.** A slot's decisions are read by `slotId` across all weeks (ids are unique per channel), not by
  `weekStart`. The move revokes every standing explicit approval of the slot (as retime does). A **vetoed slot cannot be moved**
  (`slot_vetoed`): an older build reads decisions by week and would lose the veto.
- **Refused for everyone:** slot not found, released, vetoed, changed since shown (`publishing_plan_changed`), video date within 15
  min (`publishing_plan_slot_too_soon`), target time < 30 min ahead, non-existent in the zone, beyond 52 weeks.
- **Owner** (Web UI «Изменить время», now with a week picker): any day/time; confirm dialog with from → to (channel zone, his zone,
  UTC) and the YouTube effect («дата на YouTube переедет на …» / «станет не по шаблону, дата 15:00 останется» / «дата задана
  вручную, не изменится»). The `approve` flag goes away: a move into a template position is dated by the template; elsewhere he uses
  «Дать дату вне шаблона».
- **Producer** (`producer_publishing_plan_move_slot`, §3.10): only into a **free position of the template in force** of the slot's
  kind (`template_position_required` / `template_position_taken`), with `dryRun`. Then the plan-schedule pass moves an own date
  (§3.5). §7 O5.
- **Operator / worker** (`*_publishing_plan_save`): unchanged (`slot_id_in_other_week` stays), plus a new refusal `slot_dated`:
  they cannot change the date/time of a slot whose video has a date on YouTube. An agent never shuffles release dates by a save.

### 3.8 Other consumers of the approval

- **Replaced slots (ADR 0060 §4).** A template date has no owner event, so there is no implied veto. A slot with `replacesSlotId`
  does not take the position while the replaced slot is live: it is «заменяет V66 · ждёт снятия V66», and the owner vetoes the
  replaced one (one click, which removes its own date as today). Then the replacing slot matches. An explicit «Дать дату вне
  шаблона» on a replacing slot still vetoes the replaced one (ADR 0060 §4, unchanged). §7 O4.
- **`save` rules.** `slot_approved` stays for explicit approvals; `slot_dated` (§3.7) and `slot_uploaded` cover template-dated
  slots; `unlocked` lists explicit approvals a save dropped.
- **`approvalStage`** is retired: the switch disappears, the field is ignored; only fingerprinted (packaged) explicit approvals
  count, as in the default stage today. Slot-stage approvals (no fingerprint) stop counting for new dates; dates on YouTube stay.
- **Cross-posting stays on an explicit owner decision** (ADR 0068 Am. 1: the owner's approval of one manifest SHA-256 authorizes
  the `crossPost` captions, networks and times, and the runner re-checks it before each Meta call). A template date is **not** a
  social approval: `crossPost` is packaging an agent can re-package, and the owner never saw it. So `socialSlotStates.approved`
  stays true only for a standing explicit owner decision naming the slot's current manifest (unchanged rule); template-dated slots
  post nothing (AC-WT-37). A hand-dated slot (§3.5) would post at the slot's time, not the video's real date, so a slot whose video
  has a foreign date posts nothing either. Whether the template + media approval should also authorize social posts is §7 O10.
- **Badges / wake files.** The «План» tab badge counts live future slots that are «не по шаблону» with a ready package, plus «ждёт
  проверки медиа»; template decisions and explicit dates wake the Producer (`REVIEW-DECISION-template-…`, existing slot kinds).

### 3.9 UI (owner msg 4572; texts in every UI language, AGENTS.md §H)

- Content tabs: «Видео» (BL-266 later), «Публикация», **«План»** (was «План недели»), «Трансляции». «Календарь» is removed; its
  coverage badge moves to «План». `WeeklyBuildCard` is removed from the page (module and routes untouched, §7 O7). The calendar
  API and `agent_get_publishing_calendar` stay (agents use them).
- «План» has a view switch **«Неделя | Месяц | Шаблон недели»** (the browser remembers the last).
  - **Неделя:** seven days; each slot with time (channel zone, the owner's zone in brackets, UTC on hover), kind (long/short, BL-259
    icon), package, status chip: «по шаблону · дата 15:00», «по шаблону · дата будет», «ждёт видео», «ждёт проверки медиа», «не по
    шаблону», «дата задана вручную», «снят», «вышел». Free template positions show as ghost cells («пусто · Short 12:00Z»). Actions
    only in a slot's details row (§3.6, §3.7), never on the week bar.
  - **Месяц:** month grid of plan slots plus YouTube-dated videos without a slot (the old calendar's entries), a status dot per item,
    the coverage summary; a day opens the week at that day.
  - **Шаблон недели:** per weekday the entries (kind select, hours, time typed `HH:MM` UTC, never a native picker); proposal banner;
    «Даты по шаблону» toggle (with a visible label); «Применить шаблон» → diff + effect dialog (§3.3).
- **Against misfires:** no bulk date action anywhere; every date-changing action is one slot or one template version, with a
  dialog that names the exact from → to and the YouTube effect; the confirm button names the action («Перенести V12 на ср 15:00»).

### 3.10 Agent / MCP contract

- **Factory** (Operator): `factory_publishing_template_get { channelId }` → `{ template (in force) | null, proposal (newest
  undecided) | null, matchRules: { shortMaxSeconds: 180, hoursTolerance: 0.10, time: "exact_minute_utc" } }`. Read-only.
- **Agent** (worker, own channel): `agent_publishing_template_get` (same answer).
- **Plan views** (factory/agent `*_publishing_plan_get/_list`, and the Producer's): each slot gains `dating: { source: "template" |
  "owner" | null, state: "dated" | "will_date" | "on_template_awaiting_package" | "awaiting_media_review" | "off_template" |
  "ambiguous" | "foreign_date" | "vetoed" | "released", position?: { day, index } }` and `movedFrom`. `approval` stays, derived
  ("approved" when dated by either source), deprecated. `PublishingPlanActor` gains `producer`.
- **Producer:** `producer_week_template_get`, `producer_week_template_propose { channelId, template }` (DRAFT: a proposal only),
  `producer_publishing_plan_get` / `_list` (READ), `producer_publishing_plan_move_slot { channelId, slotId, toWeekStart, date,
  publishAt (wall time in the target plan's zone), contentHash, dryRun? }` (new permission `PLAN_MOVE`). No tool approves a
  template, gives an explicit date, vetoes or restores.
- **Save refusals:** `slot_dated` (new). `slot_id_in_other_week` stays for saves.

## 4. Migration (the switch-over changes no date on YouTube)

| Slot today | After the switch |
|---|---|
| Standing explicit approval covering the current package, video dated by this computer (e.g. WWE V1–V5, S10, S11 if so) | Counts as `source: "owner"`; date unchanged. If the slot also matches the template, still unchanged. |
| Standing explicit approval, not yet uploaded / not dated | Keeps counting as an explicit owner date (it is his per-slot decision): uploaded and dated as today (§7 O2). |
| Approval no longer covering the package (re-packaged, retimed by an agent) | Does not count. Template rule applies; else «не по шаблону». A date already on YouTube stays. |
| Date set by hand in Studio (V11, V18 on 2026-11-16) | Foreign date (§3.5): never moved or removed by the plan, whatever its slot says; «дата задана вручную». |
| Vetoed slot | Stays vetoed; never dated by the template; «Вернуть» → the template rule applies. |
| Vetoed slot an agent removed (ADR 0060) | Stays vetoed for the uploads (unchanged). |
| Revoked, or slot-stage approvals (no fingerprint) | No effect on new dates; dates on YouTube stay. |
| Channel without an approved template | Nothing dated by the template; explicit owner dates only. |

No SQLite schema change. The template maps start empty; the owner (or the Producer's proposal + his acceptance) fills them per
channel. The values in §1 sources are fixtures for the ACs, never code defaults (AGENTS.md §B).

## 5. AGENTS.md §F

The proposed wording is in ADR 0073 ("Proposed AGENTS.md §F text"). AGENTS.md is **not** edited until the owner approves it;
stage 7 applies it with PROJECT_SPEC §21.

## 6. API versions

On dev `197ed499`: Factory 1.51.0, Agent 4.22.0, Producer 1.24.0 (after BL-265). BL-267 takes **Factory 1.52.0, Agent 4.23.0,
Producer 1.25.0** (additive: new tools, new view fields, `slot_dated`, actor `producer`, wake kind `template`). Renumber at merge
if another branch takes a bump first.

## 7. Open questions

**Owner**
- **O1** Gate-off channels (Japan, Tropico): template match + ready package dates with no per-video action. Recommended: yes.
- **O2** Explicit approvals given before the switch keep counting. Recommended: yes (nothing he approved changes).
- **O3** WWE videos uploaded before the gate have no media decision, so the template never dates them. Recommended: allow «Одобрить»
  in Media review for an uploaded, undated package (today refused `package_review_uploaded`); else «Дать дату вне шаблона».
- **O4** A replacing slot waits until he vetoes the replaced one. Recommended: yes (no agent-made date removal, no double release).
- **O5** **This narrows msg 4620** (the Producer moves a slot to another week): as proposed, the Producer moves only into a free
  template position, so with no template in force it cannot move at all; the Operator/worker cannot re-time a dated slot.
  Recommended: yes (an agent then never chooses a release time the owner did not put in his template). Alternative: the Producer
  moves anywhere, and an off-template target leaves the slot «не по шаблону» with its old date removed or kept — his choice.
- **O6** Template times and weekdays in UTC. Recommended: yes. The editor shows the UTC weekday and time, labelled UTC, with the
  display-zone time beside it (e.g. «пн 15:00 UTC · вт 00:00 JST»), so a day shift is visible.
- **O7** «Сборка недели»: remove the card only, retire the module later as its own item. Recommended: yes.
- **O8** A 2-minute «Отменить» window before his own date change reaches YouTube. Recommended: not now (the confirm dialog covers it).
- **O9** Approve the §F text in ADR 0073.
- **O10** Should the template + media approval also authorize the package's social posts (`crossPost`)? Recommended: no for now —
  posts only for slots he dated explicitly (§3.8); otherwise captions he never saw go out.
- **O11** Split the owned-date rule (§3.5) into its own branch merged before BL-267? Recommended: no, no urgency. Today a
  hand-set date is touched only by a re-approval / retime at another time or a veto of its slot; V11 is public (refused anyway),
  and the owner was told not to retime or veto V18. It ships as stage 1 with the merge.

**Producer**
- **P1** `timezone` becomes `displayTimeZone` (display only), times are `publishTimeUtc`; `horizonWeeks` is informational. OK?
- **P2** Tropico/Japan Friday: one 8 h entry **replaces** the 3 h one (not both). Confirm per channel.
- **P3** WWE long without `hours` = any video over 180 s; `hours` buckets ±10 %. OK?
- **P4** Move tool shape: target as wall time in the target plan's zone + `contentHash` + `dryRun`. OK?

**Operator**
- **Op1** Adopt `week-template/1` and `factory_publishing_template_get` as in §3.2/§3.10 (read-only for the factory).
- **Op2** Short = ffprobe duration ≤ 180 s; an `S<n>` over 180 s matches nothing. Same rule in the factory?
- **Op3** The factory places slots exactly on template times (exact UTC minute); one slot per position.
- **Op4** Which fields bundle 2.5.46 reads (template, `dating`, `slot_dated`), so both pin the same API versions.

## 8. Stages (one branch `feature/bl-267-week-template`, one merge, a commit per stage)

0. **Plan + ADR 0073** (this commit).
1. **Owned-date rule** (§3.5) in `plan-schedule.ts` (`foreign_date`), the slot's «дата задана вручную»; `SlotDecision.source`
   with today's decisions as `owner`. No template yet. Live with the merge (§7 O11: no early merge needed).
2. **Template storage + model:** sync-family maps (immutable versions, decisions, conflict-merge reader), `template.ts` (strict
   schema, matcher, positions), owner services (save+approve, accept, reject, withdraw), audit, Producer wake; no date effect yet.
3. **Date rule:** `publishing-plan-progress` adds the media key + `mediaReview` (§3.4); `slotDecisions` template source with the
   media condition; media-key binding in `approvalNamesUpload` and in new explicit decisions; replaced-slot rule; `approvalStage`
   retired; single-slot explicit date; `socialSlotStates` (explicit only, §3.8); `save` `slot_dated`.
4. **Moves across weeks:** one-change move in the family, decisions by slot id, owner retime across weeks without `approve`;
   refusals of §3.7.
5. **UI:** remove «Календарь» tab and `WeeklyBuildCard`; «План» with «Неделя | Месяц | Шаблон недели»; confirm dialogs; badge;
   texts in every language.
6. **Producer + Operator contract:** `factory_publishing_template_get`, `agent_publishing_template_get`, Producer template
   get/propose, plan get/list/move (`PLAN_MOVE`); `dating`/`movedFrom` in views; API bumps (§6); boundary tests;
   `docs/interfaces.md`.
7. **Docs + review:** AGENTS §F (owner-approved text) and PROJECT_SPEC §21 (the weekly-plan date paragraph), SYSTEM_MAP,
   ARCHITECTURE, `docs/interfaces.md`, TECHNICAL_DEBT (RISK-150 closed: `approvalStage` retired; RISK-148 amended: moves read
   decisions by slot id; RISK-154 amended: a forged template decision in the synced folder; a new risk for mixed builds and the
   template maps' first-write conflict); ADR 0068 Am. 1 note; independent review; ADR 0073 → Accepted at the merge.

## 9. Acceptance criteria (written before the code, from the requirements; values by hand)

Fixtures: WWE template mon/wed/fri long 15:00Z, every day short 12:00Z; Tropico every day long 3 h 12:00Z except fri long 8 h
12:00Z. Plan zone Asia/Tokyo (UTC+9) unless stated.

Template (A1):
- **AC-WT-01** A valid template saves; refused with the field: unknown field, `channelId` of another channel, `hours` on a short,
  `hours` 0.2 / 12.25, time `15:03` or `24:00`, 7 entries a day, two identical entries (`template_duplicate_entry`).
- **AC-WT-02** In force = newest owner decision `approved` whose hash matches; after `withdrawn` → none; a version whose content
  hash no longer matches its decision → none (fail closed).
- **AC-WT-03** The Producer's proposal creates a version with no decision; nothing is dated by it until the owner accepts it.
- **AC-WT-04** The owner's edit writes one version + one `approved` decision in one change, audited, one Producer wake file.
- **AC-WT-05** Two computers each write a first template version at once; after merge both versions are readable; the in-force one
  is decided by `seq`.
- **AC-WT-06** No MCP / agent / factory path reaches approve, reject or withdraw (boundaries test).

Match (A2/A3):
- **AC-WT-07** WWE Monday slot 15:00Z, package 600 s → matches long; 14:59Z or 15:01Z → no match.
- **AC-WT-08** Short 12:00Z with duration 180 s → matches short; 181 s → no match (`off_template`).
- **AC-WT-09** Tropico: 9720 s and 11880 s match 3 h, 9719 s and 11881 s do not; Friday 28800 s matches 8 h, 10800 s on Friday does
  not.
- **AC-WT-10** Weekday is UTC: a slot at Tue 00:30 JST (= Mon 15:30Z) is Monday for matching.
- **AC-WT-11** Two live slots at Monday 12:00Z, both shorts → neither matches (`ambiguous`); one vetoed → the other matches.
- **AC-WT-12** `S7` with 200 s → no match (`template_kind_unclear`).
- **AC-WT-13** A slot on a template time without a package → `on_template_awaiting_package`, no date.

Date rule:
- **AC-WT-14** Gate on, matching slot, media approved → `slotDecisions` `approved`, `source: template`, the slot's instant.
- **AC-WT-15** Gate on, matching, media not decided → `pending` (`awaiting_media_review`); returned → `pending`.
- **AC-WT-16** Gate off, matching, ready package → `approved` (O1); package with a blocking problem → `pending`.
- **AC-WT-17** Packaging-only re-package (same media key) of a template-dated slot → still `approved`; the runner's date step and
  `decisionForRow` accept the new manifest (media / video id binding).
- **AC-WT-18** Different mp4 (`sha256`) → `pending` until the owner approves the new media.
- **AC-WT-19** A veto beats a template match; restore → the match counts again.
- **AC-WT-20** Template unreadable or withdrawn → no template `approved`; explicit owner approvals still count.
- **AC-WT-21** A template change never removes or moves a date: a slot dated at 15:00Z whose entry is removed → `pending`, the
  plan-schedule pass makes no YouTube call for it.
- **AC-WT-22** Slot within 15 min or released → no new date (unchanged margins).

Owned dates (stage 1 of the branch):
- **AC-WT-23** Row `publishAt` null, YouTube date set by hand, slot approved at another time → no `videos.update`;
  `planSync.result: foreign_date`; the slot shows the YouTube date.
- **AC-WT-24** Row date = YouTube date, slot moved → the date moves (read back); YouTube date ≠ row date → never written, also
  for a veto.
- **AC-WT-25** YouTube has no date, checks passed, slot dated by template → one write, read back, audited
  `publishing.plan_scheduled` with `source: template`.

Explicit actions / UI (A3/A4):
- **AC-WT-26** The decide route refuses `approve` with more than one slot; no route or button approves a week.
- **AC-WT-27** «Дать дату вне шаблона» on one off-template slot writes one fingerprinted `approved` decision → `source: owner`.
- **AC-WT-28** Every date-changing action opens a confirm with the exact from → to and the YouTube effect; cancel writes nothing.
- **AC-WT-29** «Календарь» tab and «Сборка недели» card are gone; «План» shows «Неделя», «Месяц», «Шаблон недели»; every new key
  exists in every UI language (ui-text tests).
- **AC-WT-30** Week view shows free template positions as ghost cells; Month view shows YouTube-dated videos without a slot.

Moves (A5):
- **AC-WT-31** Owner moves an uploaded, dated slot to next week's Wed 15:00Z (template position): one Automerge change, same id,
  `movedFrom` set; the package still names the slot; the media decision still counts; the pass moves the own date.
- **AC-WT-32** After a move, the slot's earlier decisions are found by slot id (explicit approvals revoked).
- **AC-WT-33** A vetoed slot, a released slot, a stale hash, a video date within 15 min, a target < 30 min ahead → refused, nothing
  written.
- **AC-WT-34** Producer move into a free template position → done (`dryRun` writes nothing); off-template target →
  `template_position_required`; taken → `template_position_taken`; no template in force → refused.
- **AC-WT-35** Operator / worker save changing the time of a slot whose video has a date → `slot_dated`; a save with an id from
  another week → still `slot_id_in_other_week`.

Other consumers:
- **AC-WT-36** Replacing slot at the replaced slot's position: no date while the replaced one is live; after the owner's veto of the
  replaced slot it matches. Explicit date on a replacing slot still vetoes the replaced one.
- **AC-WT-37** `socialSlotStates.approved` is false for a slot dated only by the template, and false for a slot whose video has a
  foreign date; true for a standing explicit owner decision naming the current manifest (unchanged); the runner's
  `stillApproved` re-check gives the same answers.
- **AC-WT-38** `approvalStage: "slot"` in a document → ignored; a slot-stage approval dates nothing new.
- **AC-WT-39** Migration fixture (the §4 table, one slot per row): after the switch no plan-schedule pass writes for any row that
  had a date; V11/V18-like rows (hand-set) are `foreign_date`.
- **AC-WT-40** Factory/agent/Producer views carry `dating` and `movedFrom`; `approval` is still present; the three API versions
  are 1.52.0 / 4.23.0 / 1.25.0; worker and factory endpoints have no move or propose tool.
- **AC-WT-41** Gated channel: an uploaded package whose media key has a standing approval → `mediaReview: approved`, dated by a
  match; no decision → `pending`; review document unreadable → `unreadable`, nothing dated by the template (fail closed);
  gate-off channel → `not_required`. `publishing-plans` imports neither `package-reviews` nor `publishing` (boundaries test).
- **AC-WT-42** An explicit date made by this build, then a packaging-only re-package (same `sha256` + `sizeBytes`) → still
  `approved`; a different mp4 → `pending`. An explicit decision without the media fields (older) → manifest rule as today.

## 10. Risks

- **Agents can now cause dates** (within the owner's template only). Mitigations: the template is owner-approved and immutable per
  version, the media gate stays, a template change never moves a date, saves cannot re-time a dated slot, the Producer moves only
  into free positions, every date write keeps identity check, Live writes, read-back and audit.
- **Mixed builds.** An older build ignores the template, shows per-slot approval, reads decisions by week (hence: no move of a
  vetoed slot). The upload computer is the Mac; both computers update together. Concurrent move + edit on the two computers can
  leave the id in two weeks: the existing "id in two plans → pending, veto wins" rule makes it schedule nothing.
- **Exact time match** is strict: a slot one minute off is «не по шаблону». Intended (the factory places slots on template times,
  Op3); the screen offers «Перенести на время шаблона».
- **Duration from the package.** A package without a readable duration matches nothing (fail closed).
- **Overlap.** BL-266 (Видео tab) and any branch touching `weekly-plan-panel.tsx`, `content/layout.tsx`, `slot-decision.ts`,
  `plan-schedule.ts`, the three API constants, `docs/decisions/README.md`, `docs/roadmap/BACKLOG.md`.

## 11. Deploy effects

- After the merge and restart: per-slot approve buttons are gone; channels without an approved template get dates only from his
  explicit «Дать дату вне шаблона»; existing dates stay (the owned-date rule goes live with this merge).
- The owner then sets up the templates (WWE, Tropico, Japan) or accepts the Producer's proposals; dates appear on the next
  plan-schedule pass (≤ 1 min) for matching, media-approved, uploaded videos and with the next automatic upload otherwise.
- Operator bundle 2.5.46 and the Producer pin the new API versions; Windows updates together with the Mac.
