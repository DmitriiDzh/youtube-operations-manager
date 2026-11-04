# 0063. A video deleted on YouTube is not "uploaded"

Status: Accepted (owner, Telegram 2026-11-05: msg 4039 «да» to the proposal in msg 4038; the Producer had misread deleted videos
as uploaded). Amends ADR 0051 (package states, slot progress) and ADR 0062 §2-§3 (what an approval can cover).

**Date:** 2026-11-05.
- **Plan:** `docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md`, section "BL-243", acceptance AC-WP-66..74.

## Context

A complete owner sync already stamps `videos.removed_on_youtube_at` on a video missing from the channel's uploads (schema v91,
owner 2026-10-14), and every list hides it. The package scan read only the visible list, so a package whose `Vn_youtube.json`
named a deleted video was `uploaded_unknown` with no problem -- the Japan V65-V73 case: the calendar listed them as uploaded, a
weekly-plan slot offered deleted V73 for approval, and the deleted upload kept its slot taken.

## Decision

1. **The scan reads the mark.** A package whose upload record names a removed video is `deleted_on_youtube` (problem
   `video_deleted_on_youtube`, `youtube.removedAt`); `uploaded_unknown` stays for a video the copy does not have. Every package
   says `existsOnChannel` (true / false / null) and `checkedAt`, so an agent can tell a confirmation from an unknown.
   `checkedAt` is when a sync last COMPLETED the removed check (`channels.removed_check_at`, schema v118, additive, set only on
   `removedCheck: "done"`) -- `lastSyncedAt` also moves on syncs that skip the check. `true` needs that check AND the video's
   YouTube `publishedAt` not later than it; a removed mark is proof on its own (`false`). Trade-off (review round 4, kept small):
   the `videos` table keeps no "first seen" or created-at time, and `snippet.publishedAt` becomes the publish time when a private
   video goes public -- so a video checked while private and published after the check reads `null` (unknown) until the next
   completed check. It is never wrongly `true`. The rule is one shared function (`existsOnChannelOf` in
   `src/lib/shared-video-presence/`), used by the scan and by the video list (`agent_video_list` / `factory_video_list`, which
   gain `existsOnChannel` and `removedAt`). The calendar gives `checkedAt` at its top, from the same channel row it hands to the
   scan, so the top and the items agree.
2. **A deleted video holds and dates nothing.** It holds no slot (scan marks, the approval's `heldSlots`), it is the slot's
   progress only when no other package names the slot (`failed` + `video_deleted_on_youtube`; of two deleted packages the one
   uploaded last -- the record's `uploadedAt`, else the `uploadedAt` its upload row recorded, never a row's creation time), and no
   upload row of a deleted package (its number on that slot, an older failed try included) overrides that progress. A fresh
   package with the same number counts only its own tries: rows naming its manifest, and when that manifest is byte-identical to
   the deleted one's, only rows newer than the deleted upload (the record's `uploadedAt`, or the removed video's row); with neither
   time known, none -- so no try of the deleted video ever counts. Whatever the package's state (also after the owner moved its
   record away for a re-upload), a row of a removed video blocks every row of the same number and manifest on that slot created up
   to its upload time; only later rows -- a new try -- count. One time rule everywhere: `uploadTimeOf` (the record's
   `uploadedAt`, else the row's recorded `uploadedAt`). It has no fingerprint: nothing to approve, no approval covers it -- in the view, in
   `slotDecisions` and in `save()` (removing or retiming the slot is not blocked by that approval; `save()` reads the progress for
   this only when slots are removed or, in the packaged stage, an approval stands; when the progress says the package scan was
   unavailable -- `packagesUnavailable` -- it keeps the older, stricter rule). The plan schedule never DATES
   it. Its video NUMBER stays held for uploads, so a wrong mark can never cause a second upload of the same video.
3. **Agents see it** in the calendar (`missingOnChannel`, per-item fields) and in `channel_video_list` (`videoIds` with
   `removed` / `notFound`). Additive: Agent API 4.17.0, Producer API 1.17.0, Factory API 1.43.0.

4. **One rule for an unreadable removed list.** For display and holds it means "none known": the scan goes on (such packages read
   as `uploaded_unknown`, `checkedAt` null when the check time cannot be read either), the approval's slot holds stay as before,
   and the plan progress uses the removed ids of the very scan it shows (never a second, fresher read). Only DATING fails closed:
   the plan schedule gives no date to a removed video, nor to any video of the channel while the list cannot be read. Removing a
   date (a veto) never waits on the local mark or the list -- it goes through its own live read. YouTube's "no such video"
   (`not_found` naming the id) is not proof on its own (another account, a partial answer): it ends the change only when the
   removed mark of a completed owner check names that video too (recorded `video_missing`, the row's date cleared, shown as a
   failure `video_deleted_on_youtube`); otherwise it is `refused` like any other answer and tried again after the hour -- for a
   veto and for a date alike. The constant
   `video_deleted_on_youtube` lives once, in `src/lib/shared-video-presence/` (pure; the scan, the plan, the progress and the
   plan screen use it).

## Consequences

- Read-only: no YouTube call is added. The mark is only as fresh as the last completed removed check (`checkedAt`); until a
  sync completes one after the update, `checkedAt` is null and no package says `true`.
- Known follow-up (review round 3): the removed list is read in four places (the scan, the approval's slot holds, the plan
  schedule, `channel_video_list`), each with its own failure rule (§4). One shared read with one policy object would be cleaner;
  left as is for BL-243.
- Not done (review round 2, item 6): the visible and the removed lists are two reads, not one query. Between them a sync can
  only make a video appear in neither list (read as unknown) or in both (the mark wins: deleted) -- never wrongly "on the
  channel"; one query would mean a new store shape for the scan and `channel_video_list`, left for a later change.
- Re-uploading a deleted video's package needs its `Vn_youtube.json` moved away by the owner (unchanged `youtube_record_exists`
  rule) and a free video number; not automated here.
