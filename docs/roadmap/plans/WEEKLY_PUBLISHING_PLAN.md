# Weekly publishing plan: one owner approval, scheduled uploads of approved slots (BL-225, FO-REQ-0040)

## Sources

- FO-REQ-0040 (Factory Operator, 2026-10-25; PRD-REQ-0025, owner Telegram 573/576/578: «я только подтверждал в YT manager что
  согласен с публикацией (или даже одобрял недельный план 1 раз и все)»). Pilot channel: Japan (`UC-IdugmwWRvRo9-j0yK5AbA`).
- The owner, Telegram 2026-10-25, msg 3511 answering the developer's questions: 1) agree; 2) week-or-one-by-one is **not a
  setting** -- a toggle «Всю неделю / По одному» on the plan screen itself, designed as a professional UI/UX designer would;
  3) ok; 4) thumbnails: keep a small size limit, enforced when the package is created (2 MB stays, although Google raised
  `thumbnails.set` to 50 MB on 2026-09-14); 5) the feature is for every channel, no channel-specific code. Msg 3534: the screen
  mockup approved (Контент → «План недели»).
- Item 4 of the request (the publish date last, after thumbnail, playlist and read-back) is done: BL-224 (dev 718c7318).
- ADR 0051 records the decisions. AGENTS.md §F/§G apply to stages 2-3 (a new localization path at upload).

## What it is

A **plan** per channel and week: slots with a date and a publish time in the channel's time zone. Agents (the Factory Operator
and the channel's own worker) draft and update it over MCP; the owner approves it on «План недели», the whole week at once or
slot by slot, and can veto any slot until its release. From stage 3 an approved slot's release package uploads by itself:
private, with its thumbnail, translations and AI flag, and only after a verified read-back gets the slot's date.

## Stages (one branch `feature/bl-225-weekly-plan`, separate commits)

### Stage 1 -- the plan object, the MCP tools, the plan screen

1. **Storage: a sync-gateway family `publishing_plans`**, one Automerge document per channel (the storyboards pattern, ADR
   0038), because both computers write it: agents' saves arrive on whichever computer their MCP session reaches, the owner
   decides on either. No SQLite table, so **no schema version** in stage 1.
   - `plans` by `weekStart` (a Monday, `YYYY-MM-DD`, in the plan's time zone); each plan has `timeZone` (IANA), `slots` by
     `slotId` and `decisions` by a fresh id. A save assigns or deletes single slots, never the whole map, so saves from two
     computers merge.
   - A slot: `{ slotId, date, publishAt (local wall time "YYYY-MM-DDTHH:MM" in the plan's zone), lengthHint, note }` plus
     `createdAt`, `updatedAt`, `updatedBy` (`factory` | `worker`).
   - A decision: `{ id, slotId, kind: approved | revoked | vetoed | restored, contentHash, snapshot, by: owner, device, at }`.
     Everything else is derived on read, never stored twice (below).
2. **Derived state per slot.**
   - `contentHash` = SHA-256 over the canonical `[timeZone, date, publishAt, lengthHint, note]` -- every field is locked.
   - **Approved** when the newest `approved`/`revoked` decision whose hash equals the current hash is `approved`. An agent's change
     makes the hash differ, so the slot needs the owner again; `changedAfterApproval` shows the last approved snapshot («было
     15:00»). A slot changed back to exactly the approved content is approved again (the owner approved that content).
   - **Vetoed** when the newest `vetoed`/`restored` decision of the slot (any hash) is `vetoed`. An agent's edit never clears a
     veto.
   - `status` (FO-REQ-0040 item 6): stage 1 computes `vetoed` and `planned`. `built`, `packaged` (stage 2), `uploading`,
     `scheduled`, `published`, `failed (code)` and `videoId` (stage 3) come in through a port the composition layer fills; it is
     empty in stage 1. `vetoed` wins over every other status.
   - Plan `state`: `empty` (no slots), `awaiting_approval` (a future, not vetoed slot not approved), `approved` (all such slots
     approved), `past` (the week's last slot time has passed and nothing waits).
3. **Rules of an agent's save** (`validation_failed`, `details.refused: [{ slotId?, field, reason }]`; nothing saved on any
   refusal):
   - `weekStart` a real date and a Monday (`week_start_not_monday`); `timeZone` a valid IANA zone, required when the plan is new
     (`time_zone_required` / `time_zone_invalid`);
   - a slot's `date` within `weekStart .. weekStart+6` (`outside_week`); `publishAt` a real local time whose date is the slot's
     `date` (`publish_at_invalid` / `date_mismatch`); a new or changed slot whose instant is not in the future is refused
     (`in_past`); an unchanged slot is a no-op whatever its time;
   - `slotId` 1-40 of `[A-Za-z0-9_-]`, unique in the call (`duplicate_slot`); `lengthHint` ≤ 40 characters, `note` ≤ 500;
     at most 28 slots in a plan (`too_many_slots`);
   - `removeSlotIds`: a slot that is not in the plan (`unknown_slot`) or is approved now (`slot_approved` -- the owner vetoes it
     instead) is refused; the others are deleted;
   - the input has no approval or veto field at all (strict schema): **agents can never approve**.
4. **The owner's decisions** (Web UI only, a session on the active channel):
   - approve (one slot, or the week: the list of `{ slotId, contentHash }` the screen showed) -- refused whole when any slot is
     unknown (`publishing_plan_slot_not_found`), changed since it was shown (`publishing_plan_changed`), vetoed
     (`publishing_plan_slot_vetoed`) or already released (`publishing_plan_slot_past`);
   - revoke (one approved slot, by its shown hash); veto and restore (one slot; refused once its time has passed);
   - each decision is a synced record (by, device, at) and a local audit event (`publishing_plan.*`).
5. **MCP** (reads and saves only; Factory API 1.33.0, Agent API 4.7.0, additive):
   - `factory_publishing_plan_save { channelId, weekStart, timeZone?, slots?: [slot], removeSlotIds?: [id] }` (WRITE, local:
     the synced plan; passes the device mutation gate), `factory_publishing_plan_get { channelId, weekStart }`,
     `factory_publishing_plan_list { channelId }` (newest week first);
   - `agent_publishing_plan_save/get/list`: the same for the worker's own channel only (classified `bound`), recorded as
     `worker`; capability ids `channel_production.read_publishing_plan` (READ) and `.write_publishing_plan` (DRAFT).
   - The Operator's `weekly-plan/1` file is **not imported**: the Operator maps it onto `save` (one input shape to validate;
     `hours` → `lengthHint`, `note` → `note`, the time it picks → `publishAt`).
6. **Screen: Контент → «План недели»** (owner msg 3534, mockup approved):
   - the tab between «Ролики и релизы» and «Календарь», with a badge: the slots waiting for approval;
   - week header with ‹ › arrows, the week range and a status chip; a caption: who sent the plan and when, the channel's time
     (its zone) with the owner's own time in parentheses; the toggle «Всю неделю / По одному» (view state, remembered per
     browser only -- not a setting);
   - four tiles: slots, packages ready, scheduled on YouTube, first release (stage 1: packages/scheduled read 0 until stage 2-3);
   - per slot: date and time (owner's time), thumbnail or «нет обложки», title line («Слот N · note, ≈ lengthHint» until a
     package exists), the pipeline План › Видео › Пакет › YouTube › Дата (stage 1 lights План only), the action;
   - changed after approval: highlighted, «Агент изменил … — было …», needs approval again; vetoed: struck through, «Снят вами …
     — не выйдет», «Вернуть»;
   - bottom bar in «Всю неделю»: «N слотов к одобрению (M снят) · загрузка ≈ U ед. квоты» + «Одобрить неделю»; in «По одному»:
     «Одобрить» per slot, «Отозвать» on an approved one;
   - veto is confirmed in an inline row (never a browser dialog): before upload «Слот не загрузится», after upload (stage 3)
     «Видео уже на YouTube приватно: дату выхода уберём, видео останется приватным».
   - The quota line uses publishing's `estimateUploadUnits` (the insert itself is YouTube's separate daily upload limit; the
     mockup's «1 600» predates that and is not shown).
7. **Independence (AGENTS.md §M):** `src/lib/publishing-plans/` depends on the sync family, channel connections, `zoned-time` and
   `shared-domain` only -- never on `publishing`, a Google client or the network; the tab sits in its own error boundary; the
   sync family's failure is recorded like any family's. Stage 1 makes no YouTube call.

### Stage 2 -- release package v2 and the pipeline statuses

- `yt-release-package/2`, additive to v1: `slotId`; `localizations: { <lang>: { title, description } }` (files may point at the
  folder's `localizations/<lang>.json`); `containsSyntheticMedia` (absent: the channel's setting); `thumbnails: [{ file, role:
  default | test }]` (exactly one `default`; the tests are kept for the owner's Test & Compare in Studio, never uploaded).
- Every thumbnail ≤ 2 MB (owner msg 3511 answer 4), JPEG/PNG -- refused when the package is scanned and when the composer writes
  it; the translations checked by the shared rules (title ≤ 100 characters, description ≤ 5000 bytes, no `<`/`>`, a supported
  language, never the package's own `defaultLanguage`).
- `publishing_uploads.slot_id` (schema v110, additive). The plan's `get` gets `built` (the Vn video file exists), `packaged` (a
  ready v2 package names the slot).

### Stage 3 -- automatic upload of approved slots, veto after upload

- Extends BL-209 (ADR 0046): on the computer where the owner's automatic-upload switch is on (one computer, ADR 0046 §8), a ready
  v2 package whose `slotId` is approved and not vetoed in a plan is queued with the slot's instant as `publishAt` -- no other
  approval; a package without an approved slot is never queued with a date (it stays BL-209's dateless private case).
- Order (BL-224): insert private without `publishAt`, with the package's `localizations` and AI flag → thumbnail → playlist →
  read-back of title, description, localizations, thumbnail and AI flag → only then `status.publishAt`. A failed step leaves an
  unscheduled private video and `failed (code)` on the slot.
- The translations are a new localization path (AGENTS.md §F, ADR 0051): only the package's set, only on the video this upload
  made, through `src/lib/shared-localization-merge/` rules, with read-back and audit.
- Veto before upload: the package is skipped. Veto after upload: one `videos.update` removing `publishAt` (still private),
  through the write gateway, Live writes checked, read back; the slot shows `vetoed`.
- `get` gets `uploading`, `scheduled`, `published`, `failed (code)` and `videoId`.

## Acceptance (written before the code; values computed by hand)

### Stage 1

- **AC-WP-01** A save `{ weekStart: 2026-10-26, timeZone: Asia/Tokyo, slots: [{ s1, 2026-10-26, 2026-10-26T18:00, "≈ 3 ч" }] }`
  creates the plan; `get` returns s1 `planned`, `needs_approval`, `publishAtUtc` `2026-10-26T09:00:00.000Z` (JST = UTC+9),
  `weekEnd` 2026-11-01, state `awaiting_approval`, `updatedBy` `factory`.
- **AC-WP-02** Week bounds: weekStart 2026-10-27 (a Tuesday) → `week_start_not_monday`; a slot dated 2026-11-02 →
  `outside_week`; 2026-11-01 (the Sunday) is accepted; `publishAt` 2026-10-27T18:00 on a slot dated 2026-10-26 →
  `date_mismatch`; `timeZone` `Mars/Base` → `time_zone_invalid`; a new plan without `timeZone` → `time_zone_required`.
- **AC-WP-03** A zone with summer time: Europe/Berlin, weekStart 2026-10-19 -- 2026-10-24T18:00 is `2026-10-24T16:00:00.000Z`
  (CEST, UTC+2), 2026-10-25T18:00 is `2026-10-25T17:00:00.000Z` (CET, UTC+1, after the change at 01:00Z that day).
- **AC-WP-04** With the clock at 2026-10-26T10:00Z: a new slot at 2026-10-26T18:00 Tokyo (09:00Z) → `in_past`; re-saving an
  existing slot unchanged at that time is accepted and changes nothing.
- **AC-WP-05** Agents cannot approve: a save carrying `approved`, `approval` or `vetoed` (top level or in a slot) is refused by
  the schema; the agents' surface has exactly `save`, `get`, `list`; no MCP server, agent endpoint or MCP route names the owner's
  surface (source scan); the tools are exactly `factory_publishing_plan_{save,get,list}` and `agent_publishing_plan_{save,get,list}`.
- **AC-WP-06** Approve week with the hashes shown: every listed slot becomes `approved` (`approvedAt`, by `owner`); one audit event
  per slot. A stale hash for one slot refuses the whole call (`publishing_plan_changed`) and approves nothing.
- **AC-WP-07** An agent changes approved s1 from 15:00 to 18:00 → `needs_approval`, `changedAfterApproval.previous.publishAt`
  `…T15:00`, `changedBy` the agent; changing it back to 15:00 makes it `approved` again.
- **AC-WP-08** Changing only `note` or only `lengthHint` of an approved slot also needs the owner again; a save with identical
  content keeps it approved.
- **AC-WP-09** Veto: a vetoed slot has status `vetoed` (also when approved), an approval naming it is refused
  (`publishing_plan_slot_vetoed`), an agent's edit keeps it vetoed; restore returns it to its approval state; veto or restore
  after the slot's time → `publishing_plan_slot_past`.
- **AC-WP-10** `removeSlotIds`: a not approved slot is deleted; an approved one → `slot_approved`; an unknown one → `unknown_slot`
  (nothing saved).
- **AC-WP-11** Revoke: an approved slot becomes `needs_approval`; revoking a slot that is not approved →
  `publishing_plan_changed`.
- **AC-WP-12** Channels: a worker of channel A reading or saving channel B's plan is refused before the module
  (`CHANNEL_NOT_ACTIVE`); a channel not connected on this computer → `publishing_plan_channel_unavailable`; the owner's routes
  need a session and the active channel (401 / 403).
- **AC-WP-13** Sync: an agent's save on one computer and the owner's approval on the other merge with both kept; two computers
  saving different slots of the same plan keep both slots.
- **AC-WP-14** `list` returns the channel's plans newest week first with counts (slots, approved, needs approval, vetoed) and
  the state; the badge counts future, not vetoed slots that need approval.
- **AC-WP-15** The screen: the tab, both modes, the inline veto confirmation; every text an en + ru key.
- **AC-WP-16** The module imports no other feature module, no Google client and no network.
- **AC-WP-17** Factory API 1.33.0, Agent API 4.7.0; the worker tools pinned to the own channel and recorded as `worker`.

### Stage 2

- **AC-WP-20** A v2 manifest parses with `slotId`, `localizations`, `containsSyntheticMedia`, `thumbnails`; a v1 manifest parses
  as before.
- **AC-WP-21** A thumbnail (default or test) of 2 097 153 bytes is refused (`thumbnail_too_large`); 2 097 152 is accepted; not
  exactly one `default` is refused.
- **AC-WP-22** A translation in the package's own language, over 100 characters of title, over 5000 bytes of description, or with
  `<`/`>` is refused.
- **AC-WP-23** `get` shows `packaged` for a slot named by a ready v2 package, `built` for one whose video exists.

### Stage 3

- **AC-WP-30** A week of 7 approved slots: 7 v2 packages upload private and are scheduled at their slot instants, with
  thumbnail, translations and AI flag verified by read-back; each upload row and the slot name each other.
- **AC-WP-31** A package whose slot is not approved, vetoed or absent is never queued with a date.
- **AC-WP-32** A vetoed slot whose video is scheduled: one `videos.update` removes `publishAt`, the video stays private, read back.
- **AC-WP-33** A forced thumbnail failure: the video stays private without a date; the slot shows `failed (thumbnail_failed)`.
- **AC-WP-34** The translations never touch another language, the snippet text or the video's own language; Live writes off
  writes nothing.

## Acceptance status (2026-10-25, branch `feature/bl-225-weekly-plan`)

All tested against fakes; nothing verified against the real API or by eye yet (the first real approved-slot upload is the
acceptance).

- AC-WP-01..14: `src/lib/publishing-plans/publishing-plans.test.ts`; AC-WP-13: `src/lib/sync-gateway/publishing-plans/services.test.ts`;
  AC-WP-12: the routes' `handlers.test.ts`; AC-WP-05/16/17: `publishing-plans/boundaries.test.ts`, the Factory endpoint and worker
  tool tests; AC-WP-15: `src/components/weekly-plan-model.test.ts`.
- AC-WP-20..22: `src/lib/publishing/packages-v2.test.ts`, `package-composer.test.ts` (2 MB at creation); AC-WP-23:
  `src/lib/publishing-plan-progress/progress.test.ts`, `upload-approval.test.ts` (the row's slot), `db-publishing-auto.test.ts` (v110).
- AC-WP-30..34: `upload-runner.test.ts` (order, translations, AI flag, thumbnail failure), `auto-upload.test.ts` (approved / vetoed /
  pending slots), `plan-schedule.test.ts` (veto after upload, re-approval moves the date), `video-details` (`publishAt: null`),
  `live-localizations/services.test.ts` (the shared writer's source). AC-WP-30's "≥ 48 h before release" is the Operator's lead time;
  the app enforces only the 15-minute margin.

## Owner's answers for stage 3 (Telegram msg 3537, 2026-10-25)

- The computer where the automatic-upload switch is on uploads approved slots (ADR 0046 §8: one computer only).
- A slot re-approved with a new time after its video was scheduled: the app moves the video's date itself (one `videos.update`,
  read back).
