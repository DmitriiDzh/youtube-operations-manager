# 0038. Storyboards: keyframe chains reviewed and approved before first/last-frame video is generated

Status: Accepted 2026-10-13 (merged into `dev` at 9b63975, owner msg 2750; FO-REQ-0024; owner instructions 1178 and 1183, go msg 2739).

**Date:** 2026-10-13. **Plan:** `docs/roadmap/plans/STORYBOARD_PLAN.md` (BL-184).

## Context

Video loops are now keyframe chains: stills K0 → K1 → K2 → K3 → K0, with an 8 s segment between each pair, made from a first and a
last frame. The first chain was rendered before anyone looked at its keyframes as a sequence, and a prop moved between frames.
Keyframes are cheap; video is not. The owner wants to review and comment on the chain — the action between the frames and the
state of every prop — and to approve it before any video runs. Plans (ADR 0029) cannot carry this: they are owned by one computer,
take only verdicts from the others, and have no versions, comments or approval.

## Decision

1. **A new object in its own feature module, `src/lib/storyboards/`** (AGENTS.md §M). It depends on no other feature module; a
   plan link is an optional id.
2. **One Automerge document per channel** (sync family `storyboards`), because both computers write: versions come from the
   Operator's Factory API, comments and approvals from the owner on either computer.
   - Versions are frozen snapshots keyed by id.
   - Comments and replies are maps by id.
   - An approval names a version and counts only while that version is the latest. A new version is a draft until the Operator
     submits it; the owner decides on the latest submitted version only.
   - The state is derived, never stored twice.
3. **Keyframes are channel-workspace paths with a frozen sha256.** Each computer shows them from its own copy of the workspace,
   as peer plan media are. A copy that differs is reported, not blocked.
4. **The gate: no first/last-frame video from two different images without an approved storyboard.**
   - It applies to `factory_gemini_create_job`, `factory_media_create_job` (templates whose image parameters the Operator tags
     `first_frame` / `last_frame`) and plan runs. It is a per-channel setting, on by default.
   - Such a job is refused with `storyboard_not_approved` before anything is sent or charged, unless it names the approved current
     version and a segment whose two keyframes are exactly those images.
   - A one-image job (only a first frame, or the same file twice) is not gated (owner 1183).
5. **Factory API 1.16.0, additive.** Storyboard create, update, get, list, submit and reply; `storyboardId` / `segmentId` on job
   creation and on plan report rows. Approving and requesting changes stay with the owner in the Web UI.

## Consequences

- The gate changes what two existing job tools accept, for a first/last-frame video from two images. It is a contract change for
  the Operator.
- An untagged RunPod FLF template is not recognised. The Operator tags them.
- Media's first level changes (FO-REQ-0024 A, layout chosen by the owner).

## Amendment 1 (BL-189, FO-REQ-0025, 2026-10-14; owner msgs 2813/2814)

- **Takes come from every computer.** A storyboard's takes are this computer's linked jobs and the other computers' linked jobs from
  their `media-jobs` reports (BL-188, ADR 0028 pattern). Files are not streamed: each computer plays its own copy of the channel
  folder, or says where the take was made.
- **The Operator's final file is a render of the approved version** (`renders`, `renderDecisions` in the same document; Factory API
  1.18.0 `factory_storyboard_attach_render`). It records the take of each segment it uses; the owner approves it or requests changes
  in the Web UI on either computer. A render is never edited; a new file is a new render.
