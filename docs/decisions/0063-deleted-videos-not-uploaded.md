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
   `removedCheck: "done"`, to `listedAt` -- when the uploads list was read) -- `lastSyncedAt` also moves on syncs that skip the
   check. `channel_video_list` with `videoIds` also returns it as `checkedAt` (narrow reads of the asked ids only). `true` needs that check AND the video's
   YouTube `publishedAt` not later than it; a removed mark is proof on its own (`false`). Trade-off (review round 4, kept small):
   the `videos` table keeps no "first seen" or created-at time, and `snippet.publishedAt` becomes the publish time when a private
   video goes public -- so a video checked while private and published after the check reads `null` (unknown) until the next
   completed check. It is never wrongly `true`. The rule is one shared function (`existsOnChannelOf` in
   `src/lib/shared-video-presence/`), used by the scan and by the video list (`agent_video_list` / `factory_video_list`, which
   gain `existsOnChannel` and `removedAt`). The calendar gives `checkedAt` at its top, from the same channel row it hands to the
   scan, so the top and the items agree.
2. **A deleted video holds and dates nothing.** It holds no slot (scan marks, the approval's `heldSlots`), it is the slot's
   progress only when no other package names the slot (`failed` + `video_deleted_on_youtube`; of two deleted packages the one
   uploaded last -- `uploadTimeOf`: the record's `uploadedAt`, else the `uploadedAt` its upload row recorded, never a row's
   creation time). One rule for upload rows (review round 5): a row counts for slot S only when created after the newest deleted
   upload of S and its video number -- the removed video's own row (its upload time, else its creation), else the deleted
   package record's `uploadedAt`; a deleted upload with no known time blocks every row of the number; the removed video's own row
   never counts; no deleted upload of S and the number -> the row counts. The manifest is not part of it. This holds whatever the
   package's state, also after the owner moved its record away for a re-upload. It has no fingerprint: nothing to approve, no approval covers it -- in the view, in
   `slotDecisions` and in `save()` (removing or retiming the slot is not blocked by that approval; `save()` reads the progress for
   this once per save -- the read its returned view needs; when the port's `{ progress, packagesUnavailable }` says the package scan
   was unavailable it keeps the older, stricter rule). The plan schedule never DATES
   it. Its video NUMBER stays held for uploads, so a wrong mark can never cause a second upload of the same video. Review round 7:
   a removed mark frees the SLOT for another upload only when it is at least `REMOVED_MARK_GRACE_MS` (24 h,
   `src/lib/shared-video-presence/`) newer than that upload (`steps.uploadedAt`, else `finishedAt`; the record's `uploadedAt` for a
   package) -- a fresh private upload missing from a lagging uploads playlist can be marked removed by mistake. This applies to the
   queue gate only (the approval's slot holds `holdsSlot`, and its check of deleted packages naming the slot, which every queue
   path shares), never to what is shown.
3. **Agents see it** in the calendar (`missingOnChannel`, per-item fields) and in `channel_video_list` (`videoIds` with
   `removed` / `notFound`). Additive: Agent API 4.17.0, Producer API 1.17.0, Factory API 1.43.0.

4. **One rule for an unreadable removed list.** For display and holds it means "none known": the scan goes on (such packages read
   as `uploaded_unknown`, `checkedAt` null when the check time cannot be read either), the approval's slot holds stay as before,
   and the plan progress uses the removed ids of the very scan it shows; only when that scan or its removed-list read failed does it
   read the list on its own (`removedVideoIdsOf`), so removed videos' rows still say nothing. Only DATING fails closed:
   the plan schedule gives no date to a removed video, nor to any video of the channel while the list cannot be read. Removing a
   date (a veto) never waits on the local mark or the list -- it goes through its own live read. YouTube's "no such video"
   (`not_found` naming the id with `reason: "no_item"` -- videos.list returned no item; an item without snippet/status is
   `partial` and never counts) is not proof on its own (another account): it ends the change only when the
   removed mark of a completed owner check names that video too (recorded `video_missing`, the row's date cleared, shown as a
   failure `video_deleted_on_youtube`); otherwise it is `refused` like any other answer and tried again after the hour -- for a
   veto and for a date alike. A confirmed `video_missing` keeps the row's last known date (round 7); while the video stays marked
   removed the row is skipped. Once a sync clears the mark (the video reappeared) the row shows a plain failed plan change and the
   normal veto path unschedules that date, with the usual hourly retries. When the scan's
   own removed-list read fails, the packages and rows still agree: the plan progress reads the list once and hands it to its one
   scan (round 7). The constant
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
