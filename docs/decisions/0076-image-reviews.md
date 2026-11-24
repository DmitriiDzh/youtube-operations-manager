# 0076. Master still images for review: the Producer submits a channel-folder image, only the owner approves (with or without a note) or returns it

Status: Proposed (owner TG 2547 in the Producer's chat, relayed by the Producer and the coordinator, 2026-11-23). Builds on ADR 0061
(clips for review) and ADR 0066 (decisions wake the Producer); amends ADR 0034 (the Producer's tools) for these tools only.

**Date:** 2026-11-23. **Backlog:** BL-272.

## Context

Scenes (Tropico now, Japan and WWE later) are made in two steps: a master still image (a 1920×1080 PNG) the owner approves, then a
~30 s clip made from it, which he approves in Медиа → «Клипы» (ADR 0061). Step 1 runs through Telegram albums today. Storyboards
(ADR 0038) do not fit: they need at least two keyframes and segments. The owner wants step 1 in YTM.

## Decision

1. **A new feature module `src/lib/image-reviews/`** (AGENTS.md §M: no other feature module -- clip-reviews included --, no Google
   client, no network) over a new sync family `image_reviews` (sync-gateway `image-reviews`, Syncthing subfolder `image-reviews`): one
   Automerge document per channel, a fixed genesis actor, flat maps `images` (by image id, written once at submit) and `decisions` (by
   a fresh id). The status is derived, never stored (ADR 0061 §5): the earliest owner decision counts, a Producer withdrawal only
   without one. **No database schema change** -- the clip and package reviews' pattern; a device-local table would not show the
   owner's answer on his other computer.
2. **Shared logic in `src/lib/review-items/`** (single owner of shared logic): the deciding rule (`earliestDecidingRecord`) and the
   workspace file adapter (`resolveReviewFile` -- the shared `workspace-exchange` rule --, `hashReviewFile` with its cache) move there
   from clip-reviews, which keeps its exports and behaviour (its tests are unchanged). Neither review module imports the other.
   The image status rule itself has one owner there too (`imageReviewStateOf` / `decidingImageRecord`, review fix): image-reviews'
   views and the clips' source-image port both call it.
3. **The Producer** gets four `producer-only` tools (Producer API 1.28.0): `producer_image_review_submit` and `_withdraw` (DRAFT),
   `_list` and `_get` (READ). Channel workers and the factory get none.
   - The image is a file already in the channel's folder, resolved by the shared rule at submit and whenever it is served (no `..`,
     no absolute path, the real path strictly inside that channel's workspace); `.png`,
     `.jpg`, `.jpeg` whose header (read by `sharp`) is that format, 16–16384 px a side, at most 50 MiB. Size and SHA-256 are stored:
     the owner approves exactly that file.
   - Another channel's file is outside the workspace because channel folders never nest: `channel-workspaces` refuses, when the
     owner sets a folder, one inside, equal to or around another connected channel's folder on this device
     (`CHANNEL_WORKSPACE_NESTED`, 409; review fix). This protects the clips for review too. Stored paths are not re-checked on
     load (the owner's configuration had no nested folders when this was added).
   - `requestId` (optional) makes a submit idempotent per channel: the same request again answers the stored image (`replayed:
     true`), even after the file changed or the owner answered; the same id with a different request is `image_review_request_conflict`.
   - `batchId` (optional) groups submits into one batch, the owner's grid; at most 40 images per batch, 200 pending per channel, the
     same file pending twice is `image_review_duplicate`.
4. **Only the owner decides**, in Медиа → «Кадры» (Web session, active channel): `approve` (no comment), `approve_with_note` (a note
   required -- approved, the note is applied when the clip is made, e.g. «убрать прохожего») or `return` (a comment required). The two
   approvals need this computer's file to be the submitted one (size and SHA-256). The statuses are `pending | approved |
   approved_with_note | returned | withdrawn`. Each decision is audited on its computer (`image:<imageId>`). The owner's surface is
   created only by the image-review routes (source scan).
5. **Each owner decision wakes the Producer** exactly as clip decisions (ADR 0066): review-notify kind `image`, one file
   `REVIEW-DECISION-image-<imageId>-<decisionId>.md` with the status and his words, written by the periodic writer, nudged by the
   decision. When an owner return decides an image that also has a later owner approval (the two computers answered separately), the
   return decides; whichever reached this computer first, the Producer also gets `REVIEW-DECISION-image-<imageId>-<approvalId>-overturned-by-<returnId>.md` (status
   `approval_overturned`): the approval no longer counts, and a clip made from the image shows the owner its source as returned
   (review fix; the clip card shows the source still's current status and highlights anything but the two approvals).
6. **Link to clips:** `producer_clip_review_submit` takes an optional `approvedImageId`, stored on the clip (an additive field in the
   `clip_reviews` document). It must name an image of the same channel's image reviews whose status is `approved` or
   `approved_with_note`; anything else is refused (`clip_review_image_not_found`, `clip_review_image_not_approved`). clip-reviews reads
   it through an optional port (`createClipSourceImageLookup`, `clip-reviews/adapters/source-image.ts`) wired in its own `index.ts`
   over the sync-gateway family core with `review-items.imageReviewStateOf` -- never the image-reviews module. The owner's clip row shows the image it came from.
7. **Showing:** the full image and a large JPEG preview (shared `media-preview`, 960 px) go to the owner's browser only (this computer,
   or a remote owner session through the proxy's gate, as the clips since BL-251 amendment 2), from this computer's copy; a missing or
   changed copy is shown, never fetched elsewhere. The owner's list checks this computer's copy (resolve + SHA-256) only for a
   pending image, the only one he can approve; an answered one is `file: null`. The tab's badge reads `?view=count` (the document
   only, no file work). The shared SHA-256 cache (`review-items`, clips too) evicts the least recently used entry (500), never all.

## Consequences

- Nothing reaches YouTube; nothing is written into the channel folder.
- A reworked image is a new submission (same `sceneId`); the old one keeps its decision. The grid shows `v<n>` per scene.
- Two computers deciding the same image offline: the earlier decision counts, the later is kept but does not.
- Thumbnail variants (`kind: scene | thumbnail`) are not built: they would change the clip link's rule and the screen; a follow-up.
- The owner cannot attach files to an image decision (the clips' attachments, ADR 0065, are not reused here); a follow-up if needed.

## Compatibility / migration impact

- New sync family `image_reviews`; a computer without this version ignores it. Additive optional `approvedImageId` on clip records
  (older builds ignore it). No database schema change.
- Producer API 1.28.0, additive. Agent API and Factory API unchanged.
