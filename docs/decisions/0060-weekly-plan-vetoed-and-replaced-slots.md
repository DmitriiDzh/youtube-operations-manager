# 0060. Weekly plan: pulled slots collapse, agents may remove them, a slot may replace another

Status: Accepted (owner, Telegram 2026-11-03: msg 3997 the options, msg 3998 «делай все 3»). Amends ADR 0051 §5 and its
"an agent cannot remove … a vetoed slot" rule; everything else of ADR 0051 stands.

**Date:** 2026-11-03.
- **Plan:** `docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md`, section "BL-240", acceptance AC-WP-40..47.

## Context

When a video is replaced (Japan V66–V72 → V74–V80, Tropico V74/V75 → V77/V78), its old slot stays in the plan. The owner vetoes it,
the struck-through row stays on «План недели», and each day looks like two videos. An agent cannot remove the row: the slot was
approved before the veto, so the save refuses `slot_approved` (and a vetoed slot was refused `slot_vetoed` anyway).

## Decision

1. **The screen collapses pulled slots** under one row «Снятые слоты: N», closed by default; opened, each keeps «Вернуть». Counts,
   tiles and the uploads are unchanged.
2. **An agent may remove a vetoed slot whose video is not on YouTube**, also one approved before the veto. The veto outlives the
   slot: the uploads' decision for its id stays `vetoed` (a package naming it is never uploaded or scheduled), and the id cannot
   name a new slot (`slot_id_removed`). A removal is audited on the computer (`publishing_plan.vetoed_slot_removed`).
3. **A slot may name the slot it replaces** (`replacesSlotId`: a slot of the same channel, any week; not itself). It is part of what
   the owner approves: it joins the content hash only when set, so every hash written before stays the same and no approval moves.
4. **The owner's approval of a replacing slot also vetoes the replaced one**, in the same `addDecisions` change and with the same
   counter: one `vetoed` record carrying `replacedBy`, audited like his own veto. Skipped when the replaced slot is already vetoed,
   released or gone. It is the owner's veto (agents still never decide), so it is restorable and does everything a veto does
   (ADR 0051 stage 3: a scheduled video loses its date). The screen says so before he approves (the slot row and the week bar).

## Alternatives

- Hide a replaced slot by view only, without a veto: rejected -- an approved old slot would still be uploaded and scheduled.
- Delete a removed slot's decisions: rejected -- decisions are never edited (ADR 0051 §3), and the veto must keep stopping a package
  that names the slot.
- Refuse removal when a package names the slot: rejected -- the old releases' packages stay on disk, so the case the owner asked for
  would always be refused; the surviving veto covers the risk instead.

## Consequences

- Factory API 1.41.0, Agent API 4.15.0 (additive). `slot_vetoed` is no longer returned by the save.
- A computer on an older build hashes a slot with `replacesSlotId` without it, so the two computers disagree on that slot's approval
  until both run this build; an older build also ignores a removed slot's surviving veto. Update both computers before agents use
  the field or remove vetoed slots (RISK-148). Slots without it are unaffected.
- "Not on YouTube" is checked against the upload rows of the computer the save reaches (RISK-148).
- Two slots replacing each other are refused (`replaces_cycle`, from the independent review).

## Compatibility / migration impact

No DB schema change. The Automerge document gains two optional fields (`slots.*.replacesSlotId`, `decisions.*.replacedBy`); older
builds ignore them.
