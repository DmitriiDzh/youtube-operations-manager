# 0062. Weekly plan: one owner approval per packaged video; a slot can take an already uploaded video

Status: Accepted (owner, Telegram 2026-11-04: msg 4029 the proposal, msg 4030 «да 1», «да 2а»; request from the Producer, citing
the owner's TG 1688 to it). Amends ADR 0051 §3 (what an approval names) and §7 (the uploads' word) for the `packaged` stage; the
`slot` stage keeps ADR 0051/0060 unchanged.

**Date:** 2026-11-04.
- **Plan:** `docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md`, section "BL-242", acceptance AC-WP-50..59.

## Context

When a channel agent plans the week, the owner sees only slots without a video, and approving them adds nothing. He then approves
the same slot again once it is packaged, because an agent changing it drops the approval. Separately, an already uploaded
private video (Japan V73, `TXdICG06GZE`, uploaded for slot 2026-10-27-6, no date) cannot be put in another week's slot: a slot
cannot leave its week, and the plan schedule finds a finished upload only by the slot id the upload row was made with.

## Decision

1. **An approval stage per channel, in the synced plans document** (`approvalStage`: `packaged`, the default when absent, or
   `slot`). The owner sets it on «План недели» (switch «Одобрять пустые слоты» = `slot`); audited; no agent or MCP path. It lives
   in the document so both computers derive the same states.
2. **`packaged` stage: the owner approves the package, not the slot.** A slot is approvable only with a ready (no problems) or
   uploaded (video id) package; before that it is `awaiting_package` (no badge, not waiting, agents change it freely; the plan
   state is `planned` when nothing else waits). The approval hash is the BL-225 slot hash with the package fingerprint
   `[video, manifestSha256, videoId|null]` appended, and the decision keeps the fingerprint. Any change of time, note, package
   or video needs the owner again. Approvals made without a fingerprint do not count in this stage.
3. **The uploads check the fingerprint.** An approval counts only while it is the slot's standing approval and its fingerprint
   covers the slot's current package: `slotDecisions` reads the same package progress as the screen (a failed read approves
   nothing; vetoes still apply). `slotDecisions` returns the approved fingerprint; the automatic upload and the runner's
   date step give a date only to the approved manifest; the plan schedule dates a finished upload only when the fingerprint names
   it -- by video id when the approval carried one, else by manifest SHA-256.
4. **A slot takes an uploaded video by its package.** The worker re-points the package's `slotId`; the owner's approval then names
   the video id, and the plan schedule finds the upload by that video id, whatever slot its row was made for. A package names one slot,
   so at most one counting approval names a video; two of one video number are both `pending` (defensive). A veto records the
   slot's current package (none: that of its last approval not revoked); for a video the newest decision naming it decides -- a
   counting approval its date, a standing veto no date; a restore cancels the veto. Nothing counting leaves the date (BL-225) and
   the slot holding the package shows it, so the owner approves or vetoes (re-review of BL-242, 2026-11-04).

## Alternatives

- A per-computer setting: Mac and Windows would disagree on what waits for the owner in the same synced plan. Rejected.
- An owner action "take video X" on an empty slot: a second way to bind a video; the package already carries the binding and is
  what the owner sees (title, thumbnail). Rejected as redundant.
- Carrying old slot approvals over to the package: the owner would never have seen that video. Rejected (owner told, msg 4029).

## Consequences

- One click per video; batch «Одобрить все готовые» for the shown packaged slots.
- Every slot approved in the `slot` stage and not yet uploaded needs one approval once packaged; dates already on YouTube stay
  (a `pending` decision never removes a date).
- A thumbnail replaced in place (same manifest) is not a new approval: what YouTube shows is the uploaded thumbnail.
- An older build on the other computer ignores `approvalStage` and the fingerprints: it shows packaged-stage approvals as
  needing approval (it computes the slot hash without the fingerprint) and never schedules by them; the upload computer is the Mac
  (ADR 0046 §8). Recorded as RISK-150 until both computers run this build.
