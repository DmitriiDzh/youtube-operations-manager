# 0051. Weekly publishing plan: agents draft, the owner approves once, approved slots upload and schedule themselves

Status: Accepted (owner, Telegram msgs 3511 and 3534, 2026-10-25; FO-REQ-0040). Stage 1 built on `feature/bl-225-weekly-plan`;
stages 2-3 follow on the same branch. Amends ADR 0046 for one case (stage 3); ADR 0037 and ADR 0046 stand otherwise.

**Date:** 2026-10-25. **Plan:** `docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md` (BL-225), acceptance AC-WP-01..34.

## Context

The factory builds a week of videos ahead, and its packages already reach YouTube as private uploads by themselves (ADR 0046).
What is missing is the owner's one decision on *when* they come out: today he schedules each video himself, and the Operator's
week plan is a file he never approves in the app. He asked to approve a week once («или даже одобрял недельный план 1 раз и
все»), with a stricter slot-by-slot way on the same screen (msg 3511), for every channel.

## Problem

Where does a plan live so that both computers show and approve the same thing, what exactly does an approval cover, how does an
agent's later change interact with it, and how far may an approved slot go on its own -- without giving agents a way to decide
what is published?

## Alternatives

- **A local SQLite table per computer.** Rejected: the owner decides on either computer and agents save on whichever computer
  their session reaches; a per-device table would show two different plans.
- **A per-device report family** (the `publishing-uploads` / `live-analytics` shape). Rejected: each computer owns only its own
  report there; here both computers write the same plan.
- **An Automerge document per channel** (the `storyboards` family, ADR 0038). Chosen.
- **Import the Operator's `weekly-plan/1` file.** Not now: one input shape (the MCP save) is validated; the Operator maps its file
  onto it.

## Decision

1. **A feature module `src/lib/publishing-plans/` and a sync family `publishing_plans`** (AGENTS.md §M): one Automerge document per
   channel, a genesis with a fixed actor (merges instead of refusals), plans by `weekStart`, slots by `slotId`, decisions by a
   fresh id. A save assigns or deletes single slots, never a whole map. The module depends on the family, channel connections,
   `zoned-time` and `shared-domain` only; stages 2-3 reach `publishing` through ports filled by the composition layer. No SQLite
   table and no schema version in stage 1.
2. **Time.** The app has no channel time zone, so a plan carries one (`timeZone`, IANA, required when the plan is created). A
   slot's `publishAt` is the local wall time in that zone; its instant is derived on read (`zoned-time`). `weekStart` is a Monday
   and every slot falls inside its seven days.
3. **What an approval covers.** An approval is a decision record naming a slot and the SHA-256 of its content (`timeZone`, `date`,
   `publishAt`, `lengthHint`, `note` -- every field). It counts only while the slot still has that content: an agent's change makes
   the slot need the owner again, with the last approved content shown («было 15:00»); a change back to exactly that content is
   approved again (the owner approved that content). Approving the week is one record per slot the screen showed, each with the
   hash shown; any stale hash refuses the whole call. Revoke is the same record with `revoked`. The state is derived, never stored
   twice.
4. **«Всю неделю / По одному» is a view, not a setting** (msg 3511). Both write the same per-slot records; the browser remembers
   the last view only.
5. **Veto** is a separate pair of records (`vetoed` / `restored`, newest wins, any content). A vetoed slot is never uploaded or
   scheduled (stage 3: one done already loses its date and stays private); an agent's edit never clears it; the owner restores it
   until the slot's time. An agent cannot remove an approved slot (the owner vetoes it).
6. **Agents never decide.** The Factory Operator and the channel's worker save, get and list (`factory_publishing_plan_*`,
   `agent_publishing_plan_*`, own channel only for a worker); the save schema has no approval or veto field; the agents' surface
   of the module has no decision function and a source scan keeps the owner's surface out of every MCP path. Approve, revoke, veto
   and restore are Web UI routes behind a session on the active channel, and each writes a local audit event.
7. **Stage 3 extends ADR 0046's standing approval by one case.** On the computer where the owner's automatic-upload switch is on
   (ADR 0046 §8: one computer), a ready `yt-release-package/2` whose `slotId` is approved and not vetoed is queued with the slot's
   instant as `publishAt`: the owner's slot approval is the approval of `UPLOAD_PRIVATE` + scheduling for that slot (never
   `PUBLISH` now). Everything else of ADR 0046 holds: the same checks and runner, the identity check, Live writes before each
   write, never twice, the SHA-256 check. A package without an approved slot keeps ADR 0046's private, dateless case. The order is
   BL-224's: insert private without a date → thumbnail → playlist → read-back → only then `publishAt`; a failed step leaves the
   video private without a date and the slot `failed (code)`.
8. **Translations at upload are a new localization path** (AGENTS.md §F, paragraph «Upload localizations»): only title and
   description per language, only the package's own set, only on the video the upload itself made, never the video's own
   language, nothing deleted, the snippet text untouched (the rules of `src/lib/shared-localization-merge/`), sent with the
   insert or in one `videos.update` right after it, read back and audited. `status.containsSyntheticMedia` comes from the package
   (absent: the channel's setting, as today).
9. **Thumbnails stay at 2 MB** (msg 3511 answer 4), checked when a package is scanned and when the composer writes it -- the
   default and every test variant. Test variants are kept for Test & Compare in Studio and never uploaded (the API has none).

10. **Owner's answers for stage 3 (msg 3537).** The computer with the automatic-upload switch on uploads approved slots; a slot
   re-approved with a new time after its video was scheduled gets its date moved by the app (one `videos.update` of
   `status.publishAt`, still private, read back).
11. **Stage 2 additions.** The agents' list returns the newest 12 weeks by default (`limit` 1-52). Package v2 translations are kept
   inline in the manifest (the Operator's `localizations/<lang>.json` files are not read). The plan's `progress` port is filled by
   a composition module `src/lib/publishing-plan-progress/` (publishing's scan → slot statuses), so neither feature module imports
   the other. In stage 2 the upload still sends the channel's AI flag; the package's own flag and translations are sent from stage 3.

## Consequences

- A new sync family (19 in all) appears in Settings → «Слияние».
- Factory API 1.33.0 and Agent API 4.7.0 (additive); the Operator stops relying on the plan file for the owner's approval.
- Two computers that each had the switch on would both upload approved slots in the minutes before one reports it -- the ADR 0046
  §8 rule (one computer only) covers this case too.
- A week can be approved from the phone-sized screen only after it is fully planned; a slot added later needs its own approval.

## Compatibility / migration impact

- Stage 1: no schema change; a new Automerge document directory per computer (`publishing-plans-doc`), synced through Syncthing
  like storyboards. A computer without this build ignores the folder.
- Stage 2: `yt-release-package/2` is additive (v1 manifests parse unchanged); `publishing_uploads.slot_id` (schema v110, additive
  per ADR 0001).
