# 0073. An owner-approved week template replaces slot approval

Status: Accepted (2026-11-16, owner «Да мерджи», TG 4648). The requirement is the owner's (PRD-REQ-0195 part A via the Producer; owner msgs 4569 /
4575 «Одобрение слота вообще не нужно», Media review stays; 4572 the screens; 4620 the Producer moves a slot to another week keeping
its id; 4630–4636 the answers: moves anywhere and at once, no replacement, one plan for YouTube and the social networks, «Собрать
неделю по шаблону»). The AGENTS.md §F wording below is shown to the owner before the merge (plan §7 O9).

**Date:** 2026-11-16.
- **Plan:** `docs/roadmap/plans/WEEK_TEMPLATE_PLAN.md`, acceptance AC-WT-01..42. Backlog BL-267.
- **Amends:** ADR 0051 §3–§4 (what dates a slot; week approval), §7 and Amendment 1 (retime across weeks, no `approve` flag);
  ADR 0059 §4 (the Producer add's date source); ADR 0060 §4 (replaced slots under a template); ADR 0062 §1–§2 (`approvalStage`
  retired; the fingerprinted approval stays only as the explicit owner date, now also bound to the media); ADR 0060 §4 (no
  replacement: `replacesSlotId` gates nothing, no implied veto); ADR 0068 Am. 1 (a slot dated by the plan, template or explicit,
  authorizes its social posts: one plan for all, owner O10). Keeps ADR 0046 (private uploads), ADR 0070/0072
  (the media gate) and BL-224's date order.
- **Factory contract:** the Operator's ADR-0003 draft (`factory_publishing_template_get`, `week-template/1`), bundle **2.5.48**
  (reads `template.days[*][*].kind/hours/publishTimeUtc`, `horizonWeeks`, `displayTimeZone`, `matchRules`; `slot_dated` is final).

## Context

The owner approves every weekly-plan slot (ADR 0051, then once per packaged video, ADR 0062). On 2026-11-16 he approved three slots
at once by mistake and retimed two Shorts to the wrong day, and he set V11/V18 dates by hand in Studio. He wants to decide the
*shape* of a channel's week once and edit it himself; the media review (BL-257/265) stays his per-video check. The Producer must be
able to move a slot to another week, also an uploaded one, which `save` (`slot_id_in_other_week`) and the owner's retime
(`outside_week`) refuse today. Separately, `plan-schedule`'s `desiredDate` compares the slot's approved time with the date its own upload
row last wrote, not with YouTube's current date: a date set by hand in Studio is left alone while the slot's approval stays the
same, but is overwritten when an approval with a different time appears (re-approval, retime) and removed by a veto (a public
video is refused anyway). Template matches and Producer moves add new time sources, so the plan must check YouTube's actual date.

## Decision

1. **A week template per channel, owned by `src/lib/publishing-plans/`** (new `template.ts`), stored in the same sync family
   `publishing_plans` as two new maps: immutable whole versions (`week-template/1`: `days.mon..sun` lists of `{ kind long|short,
   hours?, publishTimeUtc }`, `horizonWeeks`, `displayTimeZone`) and owner decisions (`approved | rejected | withdrawn`, `seq`).
   The template in force is the version named by the newest owner `approved` decision whose content hash matches. Only the owner's
   Web UI approves, edits (a new version + its approval in one change) or withdraws; the Producer only proposes. Missing,
   unreadable or withdrawn = nothing is dated by the template (fail closed, §M).
2. **Match.** UTC weekday and exact UTC minute of the slot's instant; kind from the package (short = ≤ 180 s, an `S<n>` over 180 s
   matches nothing); `hours` = ±10 %; one slot per position: of two same-kind candidates the first created (then smaller `slotId`)
   takes it, the other is «не по шаблону» (`position_taken`). Long and short positions are separate; two videos may share an instant.
3. **The date rule.** A slot is dated (`slotDecisions` → `approved`, `source: "template"`) when it is not vetoed, not released,
   unique, matches the template in force, its package is ready or uploaded, and — on a channel with the review gate on — the
   owner approved its media key. The template source binds to the media key / video id, so a packaging-only re-package keeps the
   date. The existing fingerprinted owner approval stays as **«Дать дату вне шаблона»**, one slot at a time (`source: "owner"`);
   new ones also carry the mp4 `sha256` + `sizeBytes` (additive), so they too survive a packaging-only re-package. The media
   condition reaches the plan module through the `publishing-plan-progress` port (`mediaReview`, computed with `package-reviews`
   for uploaded packages too; unreadable = not approved). Week approval and every bulk approve go away. A veto wins over both.
   **Social posts follow the plan** (owner O10): a slot dated by this rule (also up to 36 h after its time) authorizes its current
   manifest's `crossPost`; the runner re-checks it before each call; a slot no longer dated by the rule posts nothing.
4. **Owned-date rule, automatic changes only (stage 1; live with the merge, plan §7 O11).** The plan-schedule pass moves or
   removes a YouTube date only when it equals the date this computer's upload row itself set; any other date is foreign — never
   moved or removed by the pass, shown as «дата задана вручную». A template change only gives first dates; it never moves or removes
   one -- review 2026-11-16: a template date is written only for a video without this computer's date, and it never outranks a
   standing owner veto (or owner date) of the same video. Explicit moves (item 5) may change any date.
5. **Moving a slot, anywhere and at once**, keeps its id: one Automerge change (delete the old key, put the new one, `movedFrom`);
   decisions are read by slot id; explicit approvals are revoked; a vetoed slot cannot be moved. The owner (Web UI, confirm dialog
   with the exact change) and the **Producer** (`producer_publishing_plan_move_slot`, permission `PLAN_MOVE`, `dryRun`) move any
   live slot to any day, time or week, on or off the template, including uploaded and dated videos and dates set in Studio. When the
   video has a date on YouTube, the move writes the new date at once through video-details' write path (identity check, backup,
   Live writes immediately before, read-back, audit), via plan-schedule's one change function in explicit mode, composed outside
   both modules; every refusal (public video, date within 15 min, switches off, no finished upload row here) comes before the
   Automerge change; the row's `publishAt` takes the new date. Review 2026-11-16: the YouTube write comes before the Automerge
   change -- a write not read back verified leaves the plan unchanged (`publishing_plan_move_youtube_failed`); a move while this
   computer still uploads the slot's video is refused (`publishing_plan_move_upload_active`); a move reports the template positions it
   takes from other slots (`displaces`). A move never gives a first date (an undated slot only changes
   position; the template rule then decides). A dated video moved off the template keeps its date (`pending` never removes one).
   The Operator / worker saves keep `slot_id_in_other_week` and gain `slot_dated`; they have no move tool.
6. **No replacement** (owner O4): every slot has its own id; `replacesSlotId` is still accepted and hashed (older saves and
   approvals keep working) but holds no position and no explicit date vetoes the replaced slot.
7. **Screens.** «Календарь» leaves the page; «Сборка недели» becomes «Собрать неделю по шаблону» on channels whose template in
   force is a music template (every entry `long` with `hours`): YTM writes the template to `05 Docs/publishing/week-template.json`,
   starts `13 Weekly_Plan v1 auto --template`, saves the job's `payloads` as the factory with the same checks and runs `13 push
   --sent` for the accepted ones. «План» has «Неделя», «Месяц» and «Шаблон недели»; no bulk date action; every date change states
   from → to and the YouTube effect before it is confirmed; every time shows the owner's browser-zone time beside UTC.
8. **APIs** (additive): Factory 1.52.0 (`factory_publishing_template_get`, `dating` / `movedFrom` in plan views, `slot_dated`),
   Agent 4.23.0 (`agent_publishing_template_get`, same view fields), Producer 1.25.0 (template get / propose, plan get / list /
   move).

## Alternatives

- **Keep per-slot approval, add a "approve all matching" button:** still a bulk action the owner misfires. Rejected (msg 4569).
- **A separate feature module / sync family for templates:** it would re-read the plan's slots for every decision and could
  disagree with them between reads. Rejected; the matcher is pure and the plan module's own.
- **Mergeable template fields:** a merge of two edits could yield a template nobody approved. Rejected for immutable versions.
- **Times in the channel zone:** summer time would move UTC release times twice a year; the owner's values are in Z. Kept as
  display only (P1, O6).
- **Producer moves only into free template positions** (the earlier proposal): narrowed msg 4620; the owner chose moves anywhere,
  at once (4630/4636).
- **A move recorded as a decision, written later by the pass:** not "at once", and the pass's owned-date rule would need an
  exception per decision. Rejected for the immediate write through the same change function.
- **Let the template move existing dates:** a template edit would silently re-schedule public plans. Rejected; first dates only.

## Consequences

- AGENTS.md §F changes (text below, for the owner's approval); PROJECT_SPEC §21 follows. ADR 0059 §4's "a date only from a slot
  the owner approved" reads "a date only by the weekly-plan rule".
- The owner's per-video act is the media review (gated channels) or nothing (gate-off channels, plan §7 O1); the template is his
  standing approval of *when*, for YouTube and the social networks (O10).
- The Producer changes release dates of dated videos on its own (owner 4630/4636); every such write is audited with `by: producer`.
- Explicit approvals made before the switch keep counting (plan §7 O2); V11/V18-like hand-set dates are never touched.

## AGENTS.md §F text (approved by the owner 2026-11-16, TG 4645/4648; now in AGENTS.md)

In the «Upload localizations» bullet, replace «A weekly-plan slot's date reaches a video only through the owner's approval of that
slot (on the computer whose automatic-upload switch is on); a veto removes an uploaded video's date (still private) through
`src/lib/video-details/`. Agents never approve a slot» with:

> A weekly-plan slot's date reaches a video only (a) when the slot matches the channel's **week template that the owner approved or
> edited himself in the Web UI** (`week-template/1`, 2026-11-16, owner msgs 4569/4575/4620/4630–4636, BL-267, ADR 0073) and, on a
> channel whose owner reviews its packages, the owner approved that video's media in Media → «Видео на проверку»; or (b) through the
> owner's explicit one-slot «Дать дату вне шаблона» in the Web UI; or (c) by an explicit **move** of a slot whose video already has
> a date, by the owner (Web UI) or the Producer (`producer_publishing_plan_move_slot`, its own endpoint only), to any day, time or
> week -- written at once through `src/lib/video-details/` (identity check, backup, Live writes immediately before, read-back,
> audit), never for a public video, never within 15 minutes, and never as a first date. Always only on the computer whose
> automatic-upload switch is on (a move: the computer that uploaded the video). A template match gives only a first date of an
> undated private video, never moves one; the plan-schedule pass otherwise changes or removes only a date that computer itself set
> (the owner's explicit date, a veto); a date set
> elsewhere (YouTube Studio, «Видео», the other computer) is changed only by an explicit move, and a template change never moves or
> removes a date. A veto removes a date the app set (still private) through `src/lib/video-details/`. A slot dated by (a) or (b)
> also authorizes its release package's social posts (`crossPost`, ADR 0068), as does a slot whose video carries that computer's own
> date at the slot's time (owner msg 4640: the social networks duplicate YouTube); never a foreign date. Agents
> never approve or withdraw a template, give a first date or veto: the Producer may propose a template and move slots as above; the
> Operator and channel workers cannot move a slot or re-time a slot whose video has a date.

In the «Producer upload queue» bullet, replace «a date only from a slot the owner approved» with «a date only by the weekly-plan
rule above».

## Compatibility / migration impact

No SQLite schema change. The `publishing_plans` document gains two root maps and `slots.*.movedFrom`; actor `producer`. An older
build ignores them: it shows per-slot approval, never dates by template and reads decisions by week (hence no move of a vetoed
slot); the upload computer is the Mac and both computers update together. The switch-over moves or removes no YouTube date
(plan §4); `approvalStage` is ignored from then on.
