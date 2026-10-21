# 0037. Uploads and scheduling of the owner's own release packages, from the Web UI, on the owner's approval only

Status: Accepted (owner, Telegram msg 2702 for the G1 probe; msg 2707 for the plan's answers: order, rescheduling while private,
the AI-use fix). §1 and §3 amended by [0046](0046-auto-private-upload.md) (2026-10-22): the owner's automatic-upload switch is a
standing approval of private, undated uploads of ready packages whose video matches its manifest's SHA-256.

**Date:** 2026-10-13.
- **Request:** FO-REQ-0023 (the Operator, from the owner's instruction 1110), relayed by the owner here on 2026-10-13 (msg 2698).
- **G1:** one private test upload and its deletion, approved in msg 2702.
- **Plan:** `docs/roadmap/plans/PUBLISHING_PLAN.md` (BL-182).

## Context

The owner uploads every video by hand in Studio, 5–10 at a time, as private and scheduled. He asked for YT Manager to do it from the
Content tab. PROJECT_SPEC §58 lists "video upload" and "automatic video publishing" as non-goals, and FUTURE_PHASES §6a records a
Publishing Pipeline whose `UPLOAD_PRIVATE` and `PUBLISH` are separate permission classes. The app has no upload code.

Google's sources disagree on whether uploads from an unverified API project created after 2020-07-28 are locked private. That is
the G1 probe.

## Decision

1. **Scope.** §58 is lifted for one case: the owner's own release packages, uploaded and scheduled from the Web UI on the owner's
   approval. Not in scope:
   - uploads or scheduling by an agent or the Producer, who get read-only tools;
   - Premieres, end screens, cards and monetisation, which the API does not offer.
2. **Every YouTube write goes through the write gateway** (ADR 0005).
   - New primitives: a resumable `videos.insert` (begin, chunk, query offset), `videos.delete` (used by the G1 probe only),
     `thumbnails.set`.
   - They are listed in `WRITE_PRIMITIVE_NAMES`, and each caller calls `assertLiveWritesAuthorized` right before them.
   - Reads go through the read gateway.
3. **The approval model is PROJECT_SPEC §34's:** draft → preview → approval → apply → verify → audit.
   - Uploading private and setting a publish date are separate approvals (`UPLOAD_PRIVATE` / `PUBLISH`). Approving a row with a
     date authorises both; a row without a date only uploads.
   - The identity check (`write-context.assertWriteChannel`) runs before each upload.
4. **Never twice.** An unknown upload outcome never leads to a second upload. The app looks for the video in the channel's uploads
   and adopts it, or asks the owner. A per-device record stops two computers from starting the same package.
5. **Quota.** `videos.insert` counts against its own daily bucket (100 calls per project), not the 10 000-unit pool. `thumbnails.set`
   and `videos.delete` cost 50 units each.
6. **Live writes stay the owner's switch.** An upload job checks it before every gateway call and pauses, never fails, while it is
   off. The job counts as busy for the idle watcher.
7. **The G1 probe is a developer-only command.**
   - It uploads one clip to Rural Japan Music as private, without a date and with `notifySubscribers=false`.
   - It reports the result, then deletes the clip.
   - It runs once, on the owner's yes (msg 2702), from the unmerged stage-0 branch against the real database (same schema). It is
     not reachable from the Web UI, MCP or the Producer.

## Consequences

- PROJECT_SPEC §58 gets a pointer to this ADR, as it has for ADR 0036.
- AGENTS.md §F's Change Set boundary is unchanged: privacy and scheduling stay outside the Change Set mechanism. They are written by
  video-details and publishing, each with its own approval.
- If G1 shows uploads are locked, the upload stage waits for Google's audit. The calendar, the reminder and History do not depend
  on it.
