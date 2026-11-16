# 0073. An owner-approved week template replaces slot approval

Status: Proposed. The requirement is the owner's (PRD-REQ-0195 part A via the Producer; owner msgs 4569 / 4575 «Одобрение слота
вообще не нужно», Media review stays; 4572 the screens; 4620 the Producer moves a slot to another week keeping its id). Open
questions and the AGENTS.md §F wording wait for the owner (plan §7).

**Date:** 2026-11-16.
- **Plan:** `docs/roadmap/plans/WEEK_TEMPLATE_PLAN.md`, acceptance AC-WT-01..42. Backlog BL-267.
- **Amends:** ADR 0051 §3–§4 (what dates a slot; week approval), §7 and Amendment 1 (retime across weeks, no `approve` flag);
  ADR 0059 §4 (the Producer add's date source); ADR 0060 §4 (replaced slots under a template); ADR 0062 §1–§2 (`approvalStage`
  retired; the fingerprinted approval stays only as the explicit owner date, now also bound to the media); ADR 0068 Am. 1 (a
  template date is not a social approval: cross-posts stay on an explicit owner decision). Keeps ADR 0046 (private uploads), ADR 0070/0072
  (the media gate) and BL-224's date order.
- **Factory contract:** the Operator's ADR-0003 draft (`factory_publishing_template_get`, `week-template/1`), bundle 2.5.46.

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
   matches nothing); `hours` = ±10 %; one slot per position (two candidates → neither).
3. **The date rule.** A slot is dated (`slotDecisions` → `approved`, `source: "template"`) when it is not vetoed, not released,
   unique, matches the template in force, its package is ready or uploaded, and — on a channel with the review gate on — the
   owner approved its media key. The template source binds to the media key / video id, so a packaging-only re-package keeps the
   date. The existing fingerprinted owner approval stays as **«Дать дату вне шаблона»**, one slot at a time (`source: "owner"`);
   new ones also carry the mp4 `sha256` + `sizeBytes` (additive), so they too survive a packaging-only re-package. The media
   condition reaches the plan module through the `publishing-plan-progress` port (`mediaReview`, computed with `package-reviews`
   for uploaded packages too; unreadable = not approved). Week approval and every bulk approve go away. A veto wins over both.
   Social posts stay on an explicit owner decision (ADR 0068 Am. 1); a template date posts nothing (plan §7 O10).
4. **Owned-date rule (stage 1 of the branch; live with the merge, no early merge needed, plan §7 O11).** The plan moves or removes a YouTube date only when it equals the date this computer's upload
   row itself set; any other date is foreign — never moved or removed, shown as «дата задана вручную». A template change only gives
   first dates; it never moves or removes one.
5. **Moving a slot, also across weeks**, keeps its id: one Automerge change (delete the old key, put the new one, `movedFrom`);
   decisions are read by slot id; explicit approvals are revoked; a vetoed slot cannot be moved. The owner moves anywhere (confirm
   dialog with the exact change); the Producer (`producer_publishing_plan_move_slot`, permission `PLAN_MOVE`, `dryRun`) only into a
   free template position; the Operator / worker saves keep `slot_id_in_other_week` and gain `slot_dated` (no re-timing of a slot
   whose video has a date).
6. **Replaced slots** under a template: the replacing slot waits until the owner vetoes the replaced one; an explicit date on it
   still vetoes the replaced one (ADR 0060 §4).
7. **Screens.** «Календарь» and «Сборка недели» leave the page; «План» has «Неделя», «Месяц» and «Шаблон недели»; no bulk date
   action; every date change states from → to and the YouTube effect before it is confirmed.
8. **APIs** (additive): Factory 1.52.0 (`factory_publishing_template_get`, `dating` / `movedFrom` in plan views, `slot_dated`),
   Agent 4.23.0 (`agent_publishing_template_get`, same view fields), Producer 1.25.0 (template get / propose, plan get / list /
   move).

## Alternatives

- **Keep per-slot approval, add a "approve all matching" button:** still a bulk action the owner misfires. Rejected (msg 4569).
- **A separate feature module / sync family for templates:** it would re-read the plan's slots for every decision and could
  disagree with them between reads. Rejected; the matcher is pure and the plan module's own.
- **Mergeable template fields:** a merge of two edits could yield a template nobody approved. Rejected for immutable versions.
- **Times in the channel zone:** summer time would move UTC release times twice a year; the owner's values are in Z. Kept as
  display only (open question P1).
- **Let the template move existing dates:** a template edit would silently re-schedule public plans. Rejected; first dates only.

## Consequences

- AGENTS.md §F changes (text below, for the owner's approval); PROJECT_SPEC §21 follows. ADR 0059 §4's "a date only from a slot
  the owner approved" reads "a date only by the weekly-plan rule".
- The owner's per-video act is the media review (gated channels) or nothing (gate-off channels, plan §7 O1); the template is his
  standing approval of *when*.
- Explicit approvals made before the switch keep counting (plan §7 O2); V11/V18-like hand-set dates are never touched.

## Proposed AGENTS.md §F text (for the owner's approval; AGENTS.md is not edited until then)

In the «Upload localizations» bullet, replace «A weekly-plan slot's date reaches a video only through the owner's approval of that
slot (on the computer whose automatic-upload switch is on); a veto removes an uploaded video's date (still private) through
`src/lib/video-details/`. Agents never approve a slot» with:

> A weekly-plan slot's date reaches a video only (a) when the slot matches the channel's **week template that the owner approved or
> edited himself in the Web UI** (`week-template/1`, 2026-11-16, owner msgs 4569/4575/4620, BL-267, ADR 0073) and, on a channel whose
> owner reviews its packages, the owner approved that video's media in Media → «Видео на проверку»; or (b) through the owner's
> explicit one-slot «Дать дату вне шаблона» in the Web UI. In both cases only on the computer whose automatic-upload switch is on,
> only more than 15 minutes ahead, and only as a first date of an undated private video or a move of a date that computer itself
> set; a date set elsewhere (YouTube Studio, «Видео», the other computer) is never moved or removed by the plan, and a template
> change never moves or removes a date. A veto removes a date the app set (still private) through `src/lib/video-details/`. Agents
> never approve or withdraw a template, give a date or veto: the Producer may propose a template and move a slot, keeping its id,
> into a free position of the approved template (`producer_publishing_plan_move_slot`, its own endpoint only); the Operator and
> channel workers cannot re-time a slot whose video has a date.

In the «Producer upload queue» bullet, replace «a date only from a slot the owner approved» with «a date only by the weekly-plan
rule above».

## Compatibility / migration impact

No SQLite schema change. The `publishing_plans` document gains two root maps and `slots.*.movedFrom`; actor `producer`. An older
build ignores them: it shows per-slot approval, never dates by template and reads decisions by week (hence no move of a vetoed
slot); the upload computer is the Mac and both computers update together. The switch-over moves or removes no YouTube date
(plan §4); `approvalStage` is ignored from then on.
