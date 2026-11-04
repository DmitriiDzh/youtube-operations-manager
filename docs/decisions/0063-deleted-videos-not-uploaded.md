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
   says `existsOnChannel` (true / false / null) and `checkedAt` (the copy's last sync), so an agent can tell a confirmation from
   an unknown.
2. **A deleted video holds and dates nothing.** It holds no slot (scan marks, the approval's `heldSlots`), it is the slot's
   progress only when no other package names the slot (`failed` + `video_deleted_on_youtube`), it has no fingerprint (nothing to
   approve; no approval covers it), and the plan schedule never reads or writes it. Its video NUMBER stays held for uploads, so a
   wrong mark can never cause a second upload of the same video.
3. **Agents see it** in the calendar (`missingOnChannel`, per-item fields) and in `channel_video_list` (`videoIds` with
   `removed` / `notFound`). Additive: Agent API 4.17.0, Producer API 1.17.0, Factory API 1.43.0.

## Consequences

- Read-only: no YouTube call is added. The mark is only as fresh as the last complete owner sync (`checkedAt`).
- Re-uploading a deleted video's package needs its `Vn_youtube.json` moved away by the owner (unchanged `youtube_record_exists`
  rule) and a free video number; not automated here.
