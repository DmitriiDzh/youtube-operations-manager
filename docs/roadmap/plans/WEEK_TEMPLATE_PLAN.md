# Week template replaces slot approval (BL-267, ADR 0073)

Owner: 2026-11-16, Producer PRD-REQ-0195 part A; owner msgs to the developer 4569 / 4575 (no slot approval at all, the owner
sets up and edits a week template, Media review stays), 4572 (screens), 4620 (the Producer moves a slot to another week keeping its
id). Template values from the owner via the Producer: TG 2376/2377 (WWE), TG 2238 (Tropico), Japan a draft. Factory contract:
the Operator's ADR-0003 draft (`factory_publishing_template_get`, `week-template/1`); bundle **2.5.48** pins with this work.
Answers 2026-11-16: owner TG 4630–4636 (O1–O10, moves, O7 weekly build by template, O10 one plan for YouTube and social
networks), Producer P1–P4 and the three templates, Operator Op1–Op4 (§7).

Status: **Built** on `feature/bl-267-week-template` (stages 1–7, §8; independent review and the merge pending). The owner answered §7; his wording for AGENTS.md §F
(ADR 0073 §"Proposed AGENTS.md §F text") is shown to him before the merge (O9); AGENTS.md is not edited until then. Part B shipped as BL-265 (ADR 0072), part C as BL-264. **BL-266 is
reserved for the «Видео» tab redesign** (not in this plan).

## 1. Goal

- **A1.** The owner stops approving slots. Per channel he sets up a **week template** (which kinds of video come out on which
  weekday at which time), edits it himself in the Web UI, or accepts / edits / rejects a template the Producer proposes.
- **A2.** The derived rule: a slot's date reaches YouTube when the slot **matches the approved template** and its package's
  **media is owner-approved** in Media review (BL-257/265 gate, on the channels that have it). Nothing else of the upload safety
  changes.
- **A3.** A slot that does not match the template stays undated and is marked «не по шаблону». The owner can still act on it, one
  slot at a time, explicitly (also at the same day and time as another video: O4).
- **A4.** Screens: «Календарь» goes away; «Сборка недели» stays as **«Собрать неделю по шаблону»** on the channels whose template
  is a music template (O7). The plan gets two views, «Неделя» and «Месяц», plus a «Шаблон недели» editor. Every action that changes a date shows the exact change and asks for confirmation; no hidden bulk action (the
  owner's misfire on 2026-11-16: three slots approved at once, then two Shorts retimed to the wrong day).
- **A5.** The owner and the Producer move a slot anywhere (another day, time or week, on or off the template), keeping its slot id,
  also when its video is uploaded and dated (also a date set by hand in Studio). A move of a dated video writes the new YouTube date
  **at once** (owner 4630/4636). The package↔slot link (manifest `slotId`) and the media review stay.
- **A6.** The template governs publishing **everywhere** (O10): a slot dated by the plan also authorizes its package's social
  posts (`crossPost`), one plan for YouTube and the social networks.
- **A7.** Times are stored in UTC; every time the owner sees shows his own local time (browser zone) next to UTC, plus the
  channel's `displayTimeZone` (O6).

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
- **Times and weekdays are UTC** (§7 P1, O6: agreed). The owner's values are given in Z, and UTC has no summer time, so a template
  never drifts. The weekday is the UTC weekday of the slot's instant. `displayTimeZone` (the Producer's `timezone`) only sets how
  the screen shows the times; it is not used for matching.
- `horizonWeeks` (1–8): how far ahead the factory plans. Informational for the factory; YTM does not use it to date (§7 P1: agreed).
- `days.*[].hours` is the factory's length bucket: on Tropico and Japan the Friday 8 h entry **replaces** the 3 h one (P2).
- `channelId` must be the document's channel. Unknown fields are refused (strict).

**Match (pure, `template.ts`).** A slot matches entry E of the template in force when:
1. weekday(slot instant, UTC) = E's day and the slot instant's UTC `HH:MM` = `E.publishTimeUtc` exactly (no tolerance);
2. the slot's package exists and its kind matches: **short** = `durationSeconds ≤ 180`; **long** = `> 180`. A code `S<n>` (BL-263)
   with a duration over 180 s matches nothing (`template_kind_unclear`);
3. with `E.hours`: `|durationSeconds − hours × 3600| ≤ 10 %` of `hours × 3600` (3 h: 9720–11880 s; 8 h: 25920–31680 s); without
   `hours`: any long video;
4. **one slot per position, first comes first (O4).** A position is (UTC date, entry index). There is no "replacement": every slot
   has its own id. When two or more live (not vetoed) slots of the same kind match one position, the **first** — earliest
   `createdAt`, then `slotId` — takes it; every other one is «не по шаблону» (`position_taken`) and waits for the owner, who may
   still date it explicitly at the same day and time. Long and short entries are separate positions: a horizontal and a vertical
   video never affect each other, and two videos may go out at the same instant.

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

A video the owner approved in Media review keeps that status; nothing in A changes package reviews (O3). A WWE video uploaded
before the gate without a media decision is therefore dated only explicitly (a move by the owner or the Producer, or «Дать дату
вне шаблона»).

`SlotDecision` (`slot-decision.ts`, restated per §M) gains `source: "template" | "owner"` and `media: { video, videoSha256,
sizeBytes, videoId|null }`. `approvalNamesUpload` compares the media key (or the video id once uploaded), so a packaging-only
re-package (BL-265) keeps the date. **Explicit owner dates bind to the media too** (the slot-approval leftover of MEDIA_GATE_PLAN §6
Q1): a new explicit decision's fingerprint gains `videoSha256` + `sizeBytes` (additive; an older build ignores them and keeps the
stricter manifest rule); a decision without them (made before this build) keeps the manifest rule (AC-WT-42). `vetoed` and
`pending` are unchanged; a veto always wins.

Consumers (no new path, only the decision's source widens): the automatic upload's queue date (`auto-upload.ts`), the Producer's
queue add (ADR 0059 §4), the runner's re-check before start and before the date step, the plan-schedule pass, cross-posting
(§3.8, O10).

### 3.5 Automatic changes never move a date set elsewhere (owned-date rule; stage 1 of the branch)

The rule binds **automatic** changes only — the plan-schedule pass acting on a template match, an explicit owner date or a veto.
Explicit moves by the owner or the Producer (§3.7) may change any date, a foreign one included (owner 4630/4636).

The pass acts on a YouTube date only when it is **this computer's own**: the upload row's `publishAt` (the date the runner's date
step, the last `planSync` or the last explicit move wrote and read back) equals YouTube's current date, read just before (as
`change()` already does).
- YouTube has no date → the pass may give a **first date** (the row's checks passed, > 15 min ahead, as today).
- YouTube's date = the row's own date → the pass may **move** it (a re-dated slot) or **remove** it (veto).
- YouTube's date ≠ the row's own date (set in Studio, in «Видео», by the other computer) → **foreign date**: the pass never moves
  or removes it; it records `planSync.result: "foreign_date"` (retried hourly, as other refusals) and the slot shows «дата задана
  вручную: …». V11/V18 are covered. Independent of the template.

**Motivation.** `desiredDate` compares the slot's approved time with `row.publishAt` — the date this row last wrote — not with
YouTube's current date, so a hand-set Studio date was overwritten by a re-approval or retime at another time and removed by a veto.
Template matches add a new automatic time source, so the pass checks YouTube's actual date itself. Live with the branch's one merge
(§7 O11).

### 3.6 Slots off the template, and the owner's explicit actions

A slot that does not match (or whose position another slot holds, or whose kind is unclear) is «не по шаблону»: no date from the
template; an upload of its ready package is still private without a date (ADR 0046). The owner acts on **one slot at a time**, in
its details row, each behind a confirm dialog (our `ConfirmDialog`) that states the exact change (times in the channel zone, his
browser zone and UTC, O6):
- **«Перенести»** (§3.7): any day, time or week; a dated video's date moves on YouTube at once;
- **«Дать дату вне шаблона»**: writes today's `approved` decision (with the package fingerprint and the media key) for that one
  slot = `source: "owner"`. Old builds understand it. Not offered for a slot waiting for its package or media review. It no
  longer vetoes another slot (no replacement, O4);
- **«Снять» / «Вернуть»** (veto / restore), unchanged.

The decide route accepts `approve` with exactly one slot (the week-approve and «Одобрить все готовые» go away, AC-WT-26).

### 3.7 Moving a slot (owner and Producer): immediate, anywhere, keeping the id

Who: the **owner** (Web UI) and the **Producer** (`producer_publishing_plan_move_slot`, its own endpoint). Both move any live slot
anywhere — another day, time or week, on or off the template — including uploaded and already dated videos and dates set by hand
in Studio. The Producer's move takes effect immediately; it never waits for the owner (owner 4630/4636).

- **The plan change.** One Automerge change: delete `<oldWeek>:<slotId>`, put `<newWeek>:<slotId>` with the same id, `createdAt`,
  length, note (and `replacesSlotId` if an older save set it), `updatedBy` the mover, and `movedFrom: { weekStart, publishAt, at,
  by }`. The target plan is created when absent, with the source plan's zone. The package's manifest `slotId` and the upload row's
  `slot_id` stay, so the package, its media review and the upload row follow the slot by id.
- **Decisions follow by slot id** across weeks (ids are unique per channel). The move revokes every standing explicit approval of
  the slot (as retime does). A **vetoed slot cannot be moved** (`publishing_plan_slot_vetoed`): an older build reads decisions by week.
- **The YouTube date (dated videos only).** When the slot's video has a date on YouTube, the move writes the new date **at once**
  through video-details' write path — identity check, backup, Live writes immediately before, read-back, audit — via the
  plan-schedule's one change function in its explicit mode (`src/composition/`; `publishing-plans` imports neither `publishing`
  nor `video-details`). Order: (1) read YouTube for the slot's upload row and refuse before anything is written — video not
  private (`publishing_plan_already_published`), its date within 15 minutes (`publishing_plan_slot_too_soon`), Live writes or
  reads off, no finished upload row of the video on this computer (`publishing_plan_move_not_here`: move it on the computer that
  uploaded it); (2) the plan change; (3) the YouTube write + read-back; (4) the row's `publishAt` = the new date (so the next
  automatic pass sees its own date, never a foreign one). A failed write after (2) leaves the plan moved and reports
  `youtube.result: "failed"`; moving the slot again to the same place retries the write (a no-op plan change).
  An explicit move may change a foreign date (§3.5 binds automatic changes only).
- **Undated videos and slots without a video.** The move changes the plan only; the template rule then decides (a move into a
  template position of a media-approved package is dated by the next pass; elsewhere it stays «не по шаблону»). **A move never
  gives a first date** — the Producer cannot date what the template does not; the owner has «Дать дату вне шаблона».
- **A dated video moved off the template** keeps its new date: the slot is «не по шаблону · дата стоит»; the decision is
  `pending`, which never removes a date; only a veto removes it.
- **Refused for everyone:** slot not found, released, vetoed, changed since shown (`publishing_plan_changed`), video already
  public (`publishing_plan_already_published`), video date or slot time within 15 min (`publishing_plan_slot_too_soon`), target
  time less than 30 min ahead (`in_past`), non-existent in the zone, beyond 52 weeks (`beyond_horizon`). Same-day and same-time as
  another slot is allowed (O4).
- **`dryRun`** (Producer and the owner's dialog): reads, checks and returns the from → to and the YouTube effect
  (`youtube: "moves" | "plan_only" | …`), writes nothing.
- **Operator / worker** (`*_publishing_plan_save`): unchanged (`slot_id_in_other_week` stays), plus `slot_dated`: they cannot
  change the date/time of a slot whose video has a date on YouTube.

### 3.8 Other consumers of the approval

- **No replacement (O4).** `replacesSlotId` is still accepted by the strict save schema and kept in the slot hash (Operator saves
  and standing approvals must not break), but it gates nothing: it neither holds a slot's template position nor makes an explicit
  date veto the replaced slot. Two slots of one kind at one position: the first takes it (§3.2 rule 4).
- **`save` rules.** `slot_approved` stays for explicit approvals; `slot_dated` (§3.7) and `slot_uploaded` cover template-dated
  slots; `unlocked` lists explicit approvals a save dropped.
- **`approvalStage`** is retired: the switch disappears, the field is ignored; only fingerprinted (packaged) explicit approvals
  count, as in the default stage today. Slot-stage approvals (no fingerprint) stop counting for new dates; dates on YouTube stay.
- **Social posts follow the plan (O10, amends ADR 0068 Am. 1).** One plan for YouTube and the social networks: a slot authorizes
  its package's `crossPost` when the plan dates it — a template match with the media condition, or a standing explicit owner date —
  evaluated by the same rule also for slots up to 36 h past (cross-posting's look-back), bound to the slot's **current** manifest
  SHA-256, which the runner re-checks before each Meta call (`stillApproved` reads the same `socialSlotStates`). Fail closed: a
  slot whose date stands but no longer matches the template (template edited or withdrawn, position taken), a slot whose video has
  a foreign date, a vetoed slot, an unreadable package scan, a slot id in two weeks — post nothing.
- **Badges / wake files.** The «План» tab badge counts live future slots that are «не по шаблону» with a ready package, plus «ждёт
  проверки медиа»; template decisions and explicit dates wake the Producer (`REVIEW-DECISION-template-…`, existing slot kinds).

### 3.9 UI (owner msg 4572; texts in every UI language, AGENTS.md §H)

- Content tabs: «Видео» (BL-266 later), «Публикация», **«План»** (was «План недели»), «Трансляции». «Календарь» is removed; its
  coverage badge moves to «План». The calendar API and `agent_get_publishing_calendar` stay (agents use them).
- **«Собрать неделю по шаблону»** (O7) replaces the «Сборка недели» card, on the channels whose template in force is a music
  template (every entry `long` with `hours`: Tropico, Japan); hidden where the template has other entries (WWE). No channel names
  in code (AGENTS.md §B). With no template in force the button is disabled. Flow, agreed with the Operator:
  1. YTM writes the template in force to `<workspace>/05 Docs/publishing/week-template.json` (`week-template/1`, the same
     serializer as `factory_publishing_template_get`);
  2. YTM starts `factory_launch.py start "13 Weekly_Plan v1" auto --template [--week YYYY-MM-DD] --json` (as today's button);
  3. when the job is done, its result (`13 status --json` → `job.result`: `{ plan, payloads[] }`, each payload an
     `agent_publishing_plan_save` body) is saved by YTM as the `factory` actor with the same checks;
  4. YTM runs `13 push --sent --plan <plan>` for the accepted ones. Refused payloads show on the card with their code; the job's
     own refusals are `no_template`, `week_has_plan`, `outside_horizon`, `job_running`. Per-slot status comes from `13 status
     --json`; a template position without a slot on a music channel shows «ждёт видео».
- «План» has a view switch **«Неделя | Месяц | Шаблон недели»** (the browser remembers the last).
  - **Неделя:** seven days; each slot with time (his browser zone, UTC beside it, the channel's `displayTimeZone` on hover), kind
    (long/short, BL-259 icon), package, status chip: «по шаблону · дата 15:00», «по шаблону · дата будет», «ждёт видео», «ждёт
    проверки медиа», «не по шаблону», «позиция занята», «дата задана вручную», «снят», «вышел». Free template positions show as
    ghost cells («пусто · Short 12:00 UTC»). Actions only in a slot's details row (§3.6, §3.7), never on the week bar.
  - **Месяц:** month grid of plan slots plus YouTube-dated videos without a slot (the old calendar's entries), a status dot per item,
    the coverage summary; a day opens the week at that day.
  - **Шаблон недели:** per weekday the entries (kind select, hours, time typed `HH:MM` UTC with his local time beside it, never a
    native picker); proposal banner; «Даты по шаблону» toggle (with a visible label); «Применить шаблон» → diff + effect dialog.
- **Against misfires:** no bulk date action anywhere; every date-changing action is one slot or one template version, with a
  dialog that names the exact from → to and the YouTube effect; the confirm button names the action («Перенести V12 на ср 15:00»).
  No undo window (O8).

### 3.10 Agent / MCP contract

- **Factory** (Operator): `factory_publishing_template_get { channelId }` → `{ template (in force) | null, proposal (newest
  undecided) | null, matchRules: { shortMaxSeconds: 180, hoursTolerance: 0.10, time: "exact_minute_utc", position:
  "first_created" } }`; `template` = `{ format, channelId, versionId, days, horizonWeeks, displayTimeZone }` with `days.*[*]` =
  `{ kind, hours?, publishTimeUtc }`. Read-only; offline mirror via `13 template-pull` (Op1). Bundle 2.5.48 reads exactly these
  fields and treats `slot_dated` as final (Op4).
- **Agent** (worker, own channel): `agent_publishing_template_get` (same answer).
- **Plan views** (factory/agent `*_publishing_plan_get/_list`, and the Producer's): each slot gains `dating: { source: "template" |
  "owner" | null, state: "dated" | "will_date" | "on_template_awaiting_package" | "awaiting_media_review" | "off_template" |
  "position_taken" | "foreign_date" | "vetoed" | "released", position?: { day, index } }` and `movedFrom`. `approval` stays,
  derived ("approved" when dated by either source), deprecated. `PublishingPlanActor` gains `producer`.
- **Slot ids** the factory writes (Op3): `<prefix>-<YYYY-MM-DD>-<HHMM>-<kind>[-<n>]`, one slot per position; YTM does not parse ids.
- **Producer:** `producer_week_template_get`, `producer_week_template_propose { channelId, template }` (DRAFT: a proposal only),
  `producer_publishing_plan_get` / `_list` (READ), `producer_publishing_plan_move_slot { channelId, slotId, toWeekStart, date,
  publishAt (wall time in the target plan's zone), contentHash, dryRun? }` (new permission `PLAN_MOVE`; immediate, §3.7). No tool
  approves a template, gives a first date, vetoes or restores.
- **Save refusals:** `slot_dated` (new). `slot_id_in_other_week` stays for saves; the Operator, the factory and the channel workers
  have no move tool.

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

## 7. Answers (2026-11-16)

**Owner (TG 4630–4636)**
- **O1** Yes: on gate-off channels (Japan, Tropico) a template match + a ready package gets a date, no per-video action.
- **O2** The current plans and approvals keep working until this ships; standing approvals keep counting; no forced migration. The
  owner and the Producer then build a new plan grid.
- **O3** A video already approved in Media review keeps that status; nothing in A changes package reviews.
- **O4** No replacement concept: every slot has its own id; slots are only rearranged. Two videos may go out the same day and time;
  horizontal and vertical never affect each other. Same-kind collision at one position: the first (earliest `createdAt`, then
  `slotId`) gets the template date; the next is «не по шаблону» and waits for the owner (§3.2 rule 4). `replacesSlotId` gates
  nothing (§3.8).
- **O5** The template is the base everyone aims to follow.
- **Moves** (4630 + 4636): the owner and the Producer move any video anywhere, dated ones too (also hand-set dates); the new date
  goes to YouTube at once; the Producer does not wait for the owner; the owned-date rule binds automatic changes only; a public
  video is refused; 15-minute margin; the Operator, factory and workers still cannot move (`slot_id_in_other_week`) or re-time a
  dated slot (`slot_dated`) (§3.7).
- **O6** UTC stored; every time shown with his browser-zone time beside UTC, and the channel's `displayTimeZone`.
- **O7** Keep the card as «Собрать неделю по шаблону», music channels only, hidden on WWE; flow agreed with the Operator (§3.9).
- **O8** No undo window now.
- **O9** The §F text (ADR 0073) is shown to him before the merge; it now covers the Producer's direct moves and the social posts.
- **O10** The template governs publishing everywhere — YouTube and social networks, one plan (§3.8).
- **O11** (earlier) The owned-date rule ships as stage 1 of this branch, no early merge.

**Producer** — P1 OK (`publishTimeUtc` is the truth, `timezone` display only, `horizonWeeks` informational). P2 the Friday 8 h entry
replaces the 3 h one on Tropico and Japan. P3 OK (long without `hours` = any video over 180 s; with `hours` ±10 %). P4 a move is
allowed anywhere. Templates: WWE long Mon/Wed/Fri 15:00Z + Short daily 12:00Z, horizon 2 weeks; Tropico long 3 h daily 12:00Z, Fri
8 h; Japan long 3 h daily 13:00Z, Fri 8 h. (Fixtures, never code defaults: AGENTS.md §B.)

**Operator** — Op1 yes (factory read-only; offline mirror `13 template-pull`). Op2 same ≤ 180 s rule. Op3 one slot per position,
slotId `<prefix>-<YYYY-MM-DD>-<HHMM>-<kind>[-<n>]`. Op4 bundle **2.5.48** pins with A; it reads `factory_publishing_template_get`
`{ template.days[*][*].kind/hours/publishTimeUtc, horizonWeeks, displayTimeZone, matchRules }` and treats `slot_dated` as final.

**Decisions taken in the build (not asked; listed in the report)**
- **D1** A move never gives a first date: an undated slot only changes position, then the template rule applies (§3.7).
- **D2** A move's YouTube write reuses plan-schedule's one change function in an explicit mode (no second writer), composed in
  `src/composition/`; refusals before the Automerge change; a failed write is reported and retried by moving again (§3.7).
- **D3** A dated video moved off the template keeps its date (`pending` never removes one) (§3.7).
- **D4** Social posts: authorized by the plan's dating rule, also for slots up to 36 h past, bound to the current manifest; a slot
  no longer dated by the rule posts nothing (§3.8).
- **D5** `replacesSlotId` is still accepted and hashed but gates nothing; the implied veto of ADR 0060 §4 is dropped (§3.8).
- **D6** O3 read literally: no package-reviews change; pre-gate WWE uploads without a media decision are dated only explicitly.
- **D7** «Собрать неделю по шаблону» is shown when the template in force is a music template (every entry `long` with `hours`);
  no channel names in code. The job result contract (`job.result.{plan,payloads}`) is confirmed with the Operator (open question).

## 8. Stages (one branch `feature/bl-267-week-template`, one merge, a commit per stage)

0. **Plan + ADR 0073** and the owner's answers (docs commits).
1. **Owned-date rule** (§3.5, automatic changes only) in `plan-schedule.ts` (`foreign_date`), plus the explicit one-row change
   (used by moves, stage 4); `SlotDecision.source` with today's decisions as `owner`.
2. **Template storage + model:** sync-family maps (immutable versions, decisions, conflict-merge reader), `template.ts` (strict
   schema, matcher, positions with first-created rule), owner services (save+approve, accept, reject, withdraw), Producer propose,
   audit, Producer wake; no date effect yet.
3. **Date rule:** `publishing-plan-progress` adds the media key + `mediaReview` (§3.4); `slotDecisions` template source with the
   media condition; media-key binding in `approvalNamesUpload` and in new explicit decisions; `replacesSlotId` gates nothing;
   `approvalStage` retired; single-slot explicit date; `socialSlotStates` by the dating rule (O10); `save` `slot_dated`.
4. **Moves:** one-change move across weeks in the family, decisions by slot id, owner and Producer move with the immediate YouTube
   write (§3.7); refusals.
5. **UI:** remove «Календарь»; «Собрать неделю по шаблону» (O7); «План» with «Неделя | Месяц | Шаблон недели»; local + UTC times;
   confirm dialogs; badge; texts in every language.
6. **Producer + Operator contract:** `factory_publishing_template_get`, `agent_publishing_template_get`, Producer template
   get/propose, plan get/list/move (`PLAN_MOVE`); `dating`/`movedFrom` in views; API bumps (§6); boundary tests;
   `docs/interfaces.md`.
7. **Docs + review:** PROJECT_SPEC §21 and AGENTS §F wait for the owner's approval of the text (O9); SYSTEM_MAP, ARCHITECTURE,
   `docs/interfaces.md`, TECHNICAL_DEBT (RISK-150 closed: `approvalStage` retired; RISK-148 amended: moves read decisions by slot
   id; RISK-154 amended: a forged template decision in the synced folder; a new risk for mixed builds and the template maps'
   first-write conflict; agents can now cause date changes); ADR 0068 Am. 1 note; independent review; ADR 0073 → Accepted at the merge.

## 9. Acceptance criteria (written before the code, from the requirements; values by hand)

Fixtures: WWE template mon/wed/fri long 15:00Z, every day short 12:00Z; Tropico every day long 3 h 12:00Z except fri long 8 h
12:00Z. Plan zone Asia/Tokyo (UTC+9) unless stated.

Template (A1):
- **AC-WT-01** A valid template saves; refused with the field: unknown field, `channelId` of another channel, `hours` on a short,
  `hours` 0.2 / 12.25, time `15:03` or `24:00`, 7 entries a day, two identical entries (`template_duplicate_entry`).
- **AC-WT-02** In force = newest owner decision `approved` whose hash matches; after `withdrawn` → none; a version whose content
  hash no longer matches its decision → none (fail closed).
- **AC-WT-03** The Producer's proposal creates a version with no decision; nothing is dated by it until the owner accepts it.
- **AC-WT-04** The owner's edit writes one version + one `approved` decision in one change, audited, one Producer wake.
- **AC-WT-05** Two computers each write a first template version at once; after merge both versions are readable; the in-force one
  is decided by `seq`.
- **AC-WT-06** No MCP / agent / factory path reaches approve, reject or withdraw (boundaries test).

Match (A2/A3):
- **AC-WT-07** WWE Monday slot 15:00Z, package 600 s → matches long; 14:59Z or 15:01Z → no match.
- **AC-WT-08** Short 12:00Z with duration 180 s → matches short; 181 s → no match (`off_template`).
- **AC-WT-09** Tropico: 9720 s and 11880 s match 3 h, 9719 s and 11881 s do not; Friday 28800 s matches 8 h, 10800 s on Friday does
  not.
- **AC-WT-10** Weekday is UTC: a slot at Tue 00:30 JST (= Mon 15:30Z) is Monday for matching.
- **AC-WT-11** Two live shorts at Monday 12:00Z: the one created first takes the position, the other is `position_taken`
  (equal `createdAt`: the smaller `slotId` first); the first vetoed → the other takes it. A long and a short at the same instant
  each take their own position (O4).
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

Owned dates (automatic changes only):
- **AC-WT-23** Row `publishAt` null, YouTube date set by hand, slot approved at another time → no `videos.update`;
  `planSync.result: foreign_date`.
- **AC-WT-24** Row date = YouTube date, slot re-dated → the date moves (read back); YouTube date ≠ row date → never written by the
  pass, also for a veto.
- **AC-WT-25** YouTube has no date, checks passed, slot dated by template → one write, read back, audited
  `publishing.plan_scheduled` with `source: template`.

Explicit actions / UI (A3/A4/A7):
- **AC-WT-26** The decide route refuses `approve` with more than one slot; no route or button approves a week.
- **AC-WT-27** «Дать дату вне шаблона» on one off-template slot writes one fingerprinted `approved` decision → `source: owner`; it
  vetoes no other slot (O4).
- **AC-WT-28** Every date-changing action opens a confirm with the exact from → to and the YouTube effect; cancel writes nothing.
- **AC-WT-29** «Календарь» tab is gone; «План» shows «Неделя», «Месяц», «Шаблон недели»; every new key exists in every UI language
  (ui-text tests).
- **AC-WT-30** Week view shows free template positions as ghost cells; Month view shows YouTube-dated videos without a slot.
- **AC-WT-43** (O6) A time 2026-11-23T15:00Z shown to a browser in Europe/Moscow reads «18:00 (15:00 UTC)»; in Asia/Tokyo «00:00
  (15:00 UTC)» with the next day; the channel's `displayTimeZone` is named beside it.

Moves (A5):
- **AC-WT-31** Owner moves an uploaded slot dated by this computer at Mon 2026-11-23 15:00Z to Wed 2026-12-02 15:00Z: one Automerge
  change, same id, `movedFrom` set; the package still names the slot; the media decision still counts; one `videos.update`
  with `publishAt` 2026-12-02T15:00:00.000Z, read back; the row's `publishAt` becomes that; the next pass makes no call.
- **AC-WT-32** After a move, the slot's earlier decisions are found by slot id (explicit approvals revoked).
- **AC-WT-33** A vetoed slot, a released slot, a stale hash, a public video (`publishing_plan_already_published`), a video date
  within 15 min, a target < 30 min ahead → refused, nothing written (no plan change, no YouTube call).
- **AC-WT-34** Producer moves a dated slot to an off-template time (Thu 09:00Z): done at once, YouTube date written and read back,
  the slot is `off_template` with its date standing, and the next pass does not remove it; `dryRun` writes nothing and reports
  `youtube: "moves"`; with no template in force the move still works.
- **AC-WT-35** Operator / worker save changing the time of a slot whose video has a date → `slot_dated`; a save with an id from
  another week → still `slot_id_in_other_week`; neither endpoint lists a move tool.
- **AC-WT-44** A move of a video with a date set by hand in Studio (foreign) writes the new date (explicit), while the automatic
  pass alone would not (AC-WT-23).
- **AC-WT-45** A move of an undated uploaded slot to a non-template time writes no YouTube date (D1); a move into a template
  position of a media-approved package is dated by the next pass.
- **AC-WT-46** A dated video with no finished upload row on this computer → `publishing_plan_move_not_here`, nothing written.

Other consumers:
- **AC-WT-36** (O4) A slot with `replacesSlotId` matching a free position is dated by the template while the replaced slot is
  live; an explicit date on it vetoes nothing.
- **AC-WT-37** (O10) `socialSlotStates.approved` is true for a slot dated by the template (media condition met) and for a standing
  explicit owner date, also 2 h after the slot's time (released); false for a slot whose template entry was removed, for a slot whose
  video has a foreign date, for a vetoed slot; the runner's `stillApproved` re-check gives the same answers.
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

«Собрать неделю по шаблону» (O7):
- **AC-WT-47** The template file written is exactly the `factory_publishing_template_get` `template` object (same serializer);
  the start runs `start "13 Weekly_Plan v1" auto --template --week 2026-11-23 --json`; with no template in force the start is
  refused (`weekly_build_no_template`) and nothing runs.
- **AC-WT-48** A done job's `payloads` are saved as `factory` (one save per payload, same checks); refused ones come back with their
  code; `13 push --sent --plan <plan>` runs only when at least one was accepted; a second collect of the same job saves nothing.
- **AC-WT-49** The card is shown for a template whose every entry is `long` with `hours`, hidden for one with a `short` entry.

## 10. Risks

- **Agents can now cause date changes.** The template dates only within the owner's template (immutable per version, owner-approved,
  media gate kept, a template change never moves a date). The Producer moves dated videos at once (owner 4630/4636): every write
  keeps identity check, Live writes immediately before, read-back and audit; a public video is refused; the 15-minute margin stays;
  a move never gives a first date (D1). The Operator / workers cannot move or re-time a dated slot.
- **Social posts** now follow template dates (O10): captions an agent re-packaged go out without a per-video owner look. Bound to
  the current manifest and re-checked before each Meta call; vetoes stop them.
- **Mixed builds.** An older build ignores the template, shows per-slot approval, reads decisions by week (hence: no move of a
  vetoed slot). The upload computer is the Mac; both computers update together. Concurrent move + edit on the two computers can
  leave the id in two weeks: the existing "id in two plans → pending, veto wins" rule makes it schedule nothing.
- **Exact time match** is strict: a slot one minute off is «не по шаблону». Intended (the factory places slots on template times,
  Op3); the owner or the Producer moves it.
- **Duration from the package.** A package without a readable duration matches nothing (fail closed).
- **A failed YouTube write after a move** leaves the plan moved with the old date on YouTube; reported to the mover; moving again
  retries.
- **Overlap.** BL-266 (Видео tab) and any branch touching `weekly-plan-panel.tsx`, `content/layout.tsx`, `slot-decision.ts`,
  `plan-schedule.ts`, the three API constants, `docs/decisions/README.md`, `docs/roadmap/BACKLOG.md`.

## 11. Deploy effects

- After the merge and restart: per-slot approve buttons and the «Календарь» tab are gone; channels without an approved template get
  dates only from his explicit «Дать дату вне шаблона» or a move of a dated video; existing dates stay (the owned-date rule goes live
  with this merge).
- The owner then sets up the templates (WWE, Tropico, Japan) or accepts the Producer's proposals; dates appear on the next
  plan-schedule pass (≤ 1 min) for matching, media-approved, uploaded videos and with the next automatic upload otherwise; social
  posts of template-dated slots go out from then on (O10).
- The Producer can move slots at once with `producer_publishing_plan_move_slot` (Producer API 1.25.0).
- Operator bundle **2.5.48** and the Producer pin the new API versions; Windows updates together with the Mac.

## 12. Build notes (2026-11-16)

- `retime()` (BL-256, the owner's in-week move with `approve`) stays in the module for its tests and the old route, but the Web UI
  uses `move()` only; retire it with its route in the review if wanted.
- The apply / accept dialog lists the per-day changes and the slots the template would start or stop dating (`templateEffect`,
  `POST .../template/effect`, read-only).
- Not built: the Producer wake file for template decisions (`REVIEW-DECISION-template-…`): `notifyOwnerDecision` is called, but review-notify has
  no template source yet.
- `approval` in the views stays the explicit owner approval (deprecated); `dating` is the truth. `needsOwner` / `counts.approved` /
  the plan state follow `dating` (plan §3.8 badge: off-template ready slots and slots waiting for the media review).
- A collected template build never saves over a week that already has a plan (durable across restarts); `--template` needs bundle
  2.5.48 or newer.
- «Собрать неделю по шаблону» collects a finished job's payloads when the card is open (the server remembers each job once); the
  `job.result.{plan,payloads}` field in `13 status --json` is the contract to confirm with the Operator.
