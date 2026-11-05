# Upload queue control: the Producer orders, adds and cancels uploads; the owner reorders (BL-239)

Sources:
- The owner, Telegram 2026-11-01:
  - msg 3928: «предусмотри инструмент чтобы продюсер мог регулировать порядок загрузки в очереди. Чтобы можно было при
    необходимости добавлять что-то в очередь и менять их порядок загрузки»;
  - msg 3930: (а) one Producer over every channel worker, so it may reorder rows of any channel, across channels too;
    (б) it may also cancel an upload that has not started; plus ↑↓ arrows for the owner in the Web UI uploads list.
- Scope as proposed in msg 3929, accepted («Приступай»).
- Lifts ADR 0037 §1 ("uploads or scheduling by an agent or the Producer ... out of scope", AC-UP-14) and the Producer's
  READ/DRAFT-only list (ADR 0034) for these tools only. ADR 0059 records the decision.

## Behaviour

1. **The queue.** This computer's `publishing_uploads` rows in status `queued` form one queue for every channel. Its order is a new
   column `queue_rank` (schema v117, backfilled from `created_at`), then `created_at`, then `id`. A new row gets its creation time
   in ms (an approval's rows keep their order: + index), so it joins at the end. The runner starts the first `queued` row in this
   order that is due and whose channel is not held by an upload cap -- nothing else about the runner changes: one file is sent at
   a time, and a row that is uploading, processing, finishing or paused is never interrupted or overtaken (`sending ?? next`).
2. **Move.** A `queued` row moves to a position (1-based among the queued rows). The rows are renumbered 1..N in the new order in
   one transaction; a row that stopped being `queued` meanwhile makes the move fail whole (`upload_queue_changed`). A move only
   changes which queued row starts next. A move that lands in the instant between the runner's read and its claim may let the
   previous first row start; nothing unsafe follows (it was queued and approved), the next start follows the new order.
3. **Cancel (Producer).** Only a `queued` row, by compare-and-set from `queued` (a row the runner took meanwhile is refused:
   `upload_not_cancellable`). The row is `cancelled` with `error_code = cancelled_by_producer`. The owner's own cancel is unchanged
   (it also cancels a row paused before its last byte).
4. **Add (Producer).** The Producer names a channel and a release (`video`, e.g. `V61`) on this computer:
   - refused while this computer's automatic-upload switch is off (`upload_auto_switch_off`): the switch is the owner's standing
     approval of private uploads from this computer (ADR 0046), and it marks the ONE computer that uploads and schedules
     (ADR 0046 §8, ADR 0051). Any other computer refuses, so two computers never both queue a release;
   - the package goes through the same per-package check as the automatic upload (extracted from `auto-upload.ts` into one
     function both use): ready, manifest hash (and the one the Producer names, if any), a top-level `sha256`, not held here or by
     a peer, size, then SHA-256 of the video, a vetoed plan slot refused;
   - then the approval's own `queue` (settings not in conflict, ready, held, slot taken, the `videos.insert` bucket, the quota pool
     -- an unknown quota is never acknowledged -- the tags); the row is private; its date only from an APPROVED weekly-plan slot
     more than 15 minutes ahead (the same rule as the automatic upload), otherwise no date; the plan schedule sets or removes the
     date later on the owner's slot decision. The Producer never gives a date;
   - the row freezes the manifest's `sha256`; the runner hashes the file again before its session starts (as for an automatic
     row; the runner's check now keys on the frozen hash, which only automatic and Producer rows carry);
   - one try per manifest version, as for the automatic upload, except that the Producer may queue again a version whose earlier
     rows it queued and cancelled itself: a version with any other row here (the owner's approval or cancel, an automatic try, a failure, a
     done upload) is refused (`upload_already_tried`) -- those stay the owner's;
   - the row is marked `queued_by = producer` (schema v117; `owner` / `automatic` for the others) and joins the end of the queue.
5. **List (Producer).** This computer's queue: the rows in progress (uploading, processing, finishing, paused) and the queued rows
   in order with their position, channel and its title, video, title, size, `bytesAhead` (bytes still to send before the row can
   start), status, who queued it, slot and `publishAt`; and the switch's state. No ETA: no upload speed is stored; `bytesAhead` is
   the honest part of it.
6. **Owner.** ↑↓ arrows on each queued row of the Content → «Публикация» uploads list move it one place in the shared queue (all
   channels), and the row shows its place («№ 2 из 5 в общей очереди»). Queued rows are listed first, in queue order. The route is
   `POST /api/channels/[channelId]/publishing/uploads/[uploadId]/move { direction: "up" | "down" }` (active channel only).
7. **Audit.** Every move, add and cancel writes an event with who did it: `by: "producer"` with the Producer token's id, or
   `by: "owner"` with the Google user. Events: `publishing.upload_queue_moved`, `publishing.upload_producer_queued`,
   `publishing.upload_cancelled` (`by` added to the owner's existing one too).
8. **Who reaches it.** Four `producer-only` tools on `/api/mcp/producer` (Producer API 1.14.0, permission `UPLOAD_QUEUE`):
   `producer_upload_queue_list`, `producer_upload_queue_add`, `producer_upload_queue_move`, `producer_upload_queue_cancel`.
   Channel worker agents (`/api/mcp`) and the factory endpoint get nothing. The core (`createUploadQueueControlCore`) is reached
   only from the Producer session's wiring and the owner's move route. Add, move and cancel are refused while the app is paused
   for a device handoff or recovery (the device mutation gate).

## Acceptance (written before the code)

- **AC-UQ-01** Order: with queued rows A (older) and B (newer), B moved to position 1 starts first; A starts after B is sent.
- **AC-UQ-02** No preemption: while row S is uploading, moving queued row B to position 1 does not start B; S finishes its bytes
  first, then B starts.
- **AC-UQ-03** Move semantics: queued [A, B, C], move C to 1 → [C, A, B]; move A to 3 → [C, B, A]; a position past the end is the
  end; position 0 or not an integer is refused at input.
- **AC-UQ-04** Move refusals: an unknown id or one of another channel → `upload_not_found`; a row that is uploading, done, failed or
  cancelled → `upload_not_movable`; a row that left `queued` during the move → `upload_queue_changed`, nothing renumbered.
- **AC-UQ-05** Cancel: a queued row → `cancelled`, `cancelled_by_producer`, audited `by: producer`; a row uploading (or paused,
  processing, done) → `upload_not_cancellable`, unchanged; unknown id / other channel → `upload_not_found`.
- **AC-UQ-06** Add, happy path: switch on, a ready package whose video matches its `sha256` → one `queued` row, private, `publishAt`
  null, `queued_by = producer`, `videoSha256` frozen, last in the queue, audited `by: producer`.
- **AC-UQ-07** Add with an approved slot more than 15 min ahead → `publishAt` = the slot's time; a pending slot → no date; a vetoed
  slot → `upload_slot_vetoed`, nothing queued.
- **AC-UQ-08** Add refusals, nothing queued and no hash computed where the size already fails: switch off (`upload_auto_switch_off`);
  channel not connected (`CHANNEL_NOT_ACTIVE`); no such release (`upload_package_not_ready`); not ready (`upload_package_not_ready`);
  the named manifest hash differs (`upload_package_changed`); no `sha256` (`upload_package_no_sha256`); held here or by a peer
  (`upload_already_queued`); size or SHA-256 differ (`upload_video_mismatch`); a version tried before by anyone but a Producer
  cancel (`upload_already_tried`); a version whose only earlier row the Producer cancelled is queued again.
- **AC-UQ-09** The runner hashes a Producer row's file again before its session starts and fails it (`video_hash_mismatch`) when it
  changed; an approval row (no frozen hash) is not hashed.
- **AC-UQ-10** List: positions 1..N in queue order across channels, `bytesAhead` = the sending row's remaining bytes + the sizes of
  the queued rows before; in-progress rows listed apart.
- **AC-UQ-11** Isolation: a channel worker session and the factory endpoint list none of the four tools; the tools are classified
  `producer-only`; no MCP / agent endpoint code reaches the approval, the runner, the automatic queue or the owner's cancel; the
  queue core is referenced only by the Producer session wiring, the owner's move route and the publishing module.
- **AC-UQ-12** Owner move route: up/down move one place; unauthenticated 401; inactive channel refused; a non-queued row 409.
- **AC-UQ-14** (independent review #1) A Producer row whose slot is no longer approved (pending, or vetoed) when the date step
  comes gets no date (`withheld`), like an automatic row; an owner's own row keeps the date he approved.
- **AC-UQ-15** (independent review #4) A row the owner approved (or the automatic upload queued) that the Producer cancelled stays
  the owner's: the Producer cannot add that manifest version again (`upload_already_tried`); only rows it queued itself can be.
- **AC-UQ-13** Schema v117: `queue_rank` and `queued_by` added and backfilled (rank = created_at; `queued_by` from `automatic`).

## BL-244: stop an upload that is being sent (ADR 0064)

Source: the owner, Telegram 2026-11-05, msgs 4046/4050: «Можешь дать продюсеру останавливать начатые загрузки?» -- yes, a stop for
both the owner (Web UI) and the Producer (MCP), through one shared function. Amends §3 above and ADR 0059 §3.

### Behaviour

1. **What can be stopped.** A row with no video id whose last chunk was never marked (`steps_json.finalChunkSentAt` absent) and
   that still has bytes to send: `queued` (unchanged), `uploading` (new), or `paused` with `resume_status` `queued` / `uploading`
   (the owner could already; now the Producer too: a paused-while-sending row is a started upload). Anything else is refused with
   `upload_not_cancellable`: `processing`, `finishing`, `done`, `failed`, `cancelled`, and any row whose last chunk was marked --
   from then on YouTube may have made the video, so the row runs to its end and the owner deletes the video in Studio if needed.
2. **One statement.** The stop is a single conditional `UPDATE` (`stopPublishingUploadBeforeYoutube` in `db.ts`): the status, `video_id
   IS NULL`, `stored_bytes < total_bytes` and the absence of `finalChunkSentAt` are checked by the same statement that writes
   `cancelled`. The runner marks the last chunk with a compare-and-set on `uploading` before it sends it, so exactly one of the two
   wins: the stop (the runner's mark fails and the last chunk is never sent) or the mark (the stop is refused,
   `details.reason = final_chunk_sent`).
3. **The runner after a stop.** Its next compare-and-set fails and it returns; its lease (`claim`) is taken only while the row is
   active, so no further chunk starts after the stop -- at most the chunk already in flight finishes. It never marks the stopped
   row failed or audits a failure that did not happen.
4. **The row.** `cancelled`, `finished_at` / `updated_at` now; a Producer's stop sets `error_code = cancelled_by_producer` (so it
   may queue the same manifest version again, as after its queued cancel); the owner's leaves `error_code` as it was. Like any
   cancelled row without a video, it holds neither its package nor its weekly-plan slot.
5. **Audit.** `publishing.upload_cancelled` for a queued row, `publishing.upload_stopped` for one that was sending (or paused
   while sending), with `by` (owner + Google user / producer + token id), the status it had and `storedBytes` / `totalBytes` at the
   stop (read from the stop's own statement).
6. **YouTube.** No call: the abandoned resumable session expires by itself and no video exists before the last chunk.
7. **Owner.** The uploads list in Content → «Публикация» shows «Остановить загрузку» on a row being sent (or paused while
   sending) before its last chunk, with the app's own confirmation dialog; a queued row keeps «Отменить» without one. Same route
   (`POST .../publishing/uploads/[uploadId]/cancel`), which now goes through the queue control's `cancel` as the owner.
8. **Producer.** `producer_upload_queue_cancel` also stops such a row (one tool, as ADR 0059 has one cancel): Producer API 1.18.0.
   Channel workers and the factory still get no upload tool.

### Acceptance (written before the code)

- **AC-STOP-01** A row `uploading`, `videoId` null, no `finalChunkSentAt`, stored < total: the Producer's stop makes it `cancelled`
  with `cancelled_by_producer`, `finishedAt` / `updatedAt` = now; audit `publishing.upload_stopped`, `by: producer`, the token,
  `status: uploading`, `storedBytes` / `totalBytes` as stored at the stop.
- **AC-STOP-02** The same by the owner: `cancelled`, `errorCode` unchanged (null), `queuedBy` unchanged; audit `by: owner` with
  the user id.
- **AC-STOP-03** The mark wins: a row whose `finalChunkSentAt` is set one instant before the stop (the read saw none) is refused
  `upload_not_cancellable` (`details.reason = final_chunk_sent`) and stays `uploading`; nothing audited.
- **AC-STOP-04** Refused and unchanged: `processing`, `finishing`, `done`, `failed`, `cancelled`, `uploading` with a video id,
  `uploading` with `finalChunkSentAt`, `paused` after its last chunk (`finalChunkSentAt`, or every byte stored).
- **AC-STOP-05** Unchanged: `queued` is cancelled as before (event `publishing.upload_cancelled`); `paused` before its last chunk
  is cancelled (owner and now Producer).
- **AC-STOP-06** Another channel's row or an unknown id: `upload_not_found`, nothing changes.
- **AC-STOP-07** After its own stop the Producer may add the same manifest version again; the owner's stop of a row keeps it his
  (`upload_already_tried` for the Producer).
- **AC-STOP-08** Runner: a row stopped after chunk 0-3 of 10 bytes (4-byte chunks) sends no further chunk -- in particular never
  the last one (8-9) -- leaves the row `cancelled`, writes no `finalChunkSentAt`, audits no failure; YouTube has no video.
- **AC-STOP-09** Runner: a stop that comes while the last chunk is being marked loses -- the row is marked first, the stop is
  refused, the upload finishes and the video is adopted.
- **AC-STOP-10** SQL (real SQLite): the conditional update cancels `queued`, `uploading` and `paused` rows before their last
  chunk and returns the stored bytes; it writes nothing for a row with `finalChunkSentAt`, a video id, every byte stored, or any
  other status; `claimPublishingUpload` takes no lease on a cancelled row.
- **AC-STOP-11** A stopped row holds neither its package (`holdsPackage` false) nor its slot, and a new upload row of the same
  video can be inserted.
- **AC-STOP-12** Web UI: `isCancellable` is true for an `uploading` row before its last chunk; the stop button's texts exist in
  every locale; the route passes the owner's user id.
- **AC-STOP-13** MCP: `producer_upload_queue_cancel` is still the one cancel tool (four queue tools, producer-only), Producer API
  1.18.0, its description names the stop.
