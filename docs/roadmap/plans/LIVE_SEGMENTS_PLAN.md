# Live streams in segments under 12 h, with recordings (BL-205, FO-REQ-0032)

**Status: built 2026-10-19 on `feature/fo-req-0032-live-segments` (stages 1-2); acceptance with the owner pending.** The owner said "да начинай" (Telegram msg 3178) after spike D (msg 3175). The branch is
`feature/fo-req-0032-live-segments`.

- **The request:** the Operator's FO-REQ-0032 (from the Producer's PRD-REQ-0015). It is in the Developer Exchange `Outbox/`.
- **What it builds on:**
  - BL-176 (`LIVE_STREAMS_PLAN.md`, ADR 0036);
  - BL-186 stage 3 (`LIVE_STREAMS_FIELDS_PLAN.md` §5.1: video settings applied after a broadcast starts);
  - ADR 0044 (Live writes are on by default, so the app may write without the owner pressing a button).

## 1. Facts

### 1.1 Spike D (2026-10-19, Tropico, unlisted test broadcasts, deleted afterwards)

- `liveBroadcasts.bind` of a new broadcast B to the **same reusable stream** succeeds while A is live on it.
- `transition B → live` takes B to `liveStarting`, then to `live` in about 8 s. For a while **A and B are both live** on one
  encoder. Then `transition A → complete`.
- YouTube's own times: B `actualStartTime` 12:50:17, A `actualEndTime` 12:50:19. That is 2 s of overlap and **no gap**. The whole
  switch took about 13 s. The encoder was never restarted.
- A's recording is a video at once (unlisted, duration 33 s). YouTube still reported it as "processing" after 6 minutes.
- **Quota per switch** (from the app's ledger): insert, bind, transitions and a few reads come to about 5–10 units. The app counts
  live calls at 1 unit. Add 50 for a thumbnail and 50 per playlist insert.
- A second transition request on a broadcast that is already `liveStarting` returns 403 "Redundant transition". It is treated as
  done.

### 1.2 YouTube rules (FO-REQ-0032 sources)

- A broadcast is archived only when it is under 12 h.
- **Live Redirect has no API field.** It is set in Studio only, and needs more than 1,000 subscribers. Neither channel qualifies.
  The owner is checking Studio (msg 3151). `youtube.com/@<handle>/live` always opens the current segment.
- Spike C: Tropico may not switch recording off. Segments always record anyway.

### 1.3 The app today

- **One broadcast per Start.** `live_streams.broadcast_id` names it; the encoder runs on the channel's reusable `stream_id`.
- **The runner** (`runner.ts`) tends each stream that is on every few seconds and reads its broadcast every 1–5 min. If YouTube
  ended it (`complete`/`revoked`/`not_found`), the encoder stops and the intent goes off.
- **Since BL-186 stage 3,** a new broadcast gets the saved video settings: the fields, thumbnail and playlists.

## 2. Design

### 2.1 Settings (per channel, local, schema v99)

`live_streams.segments_json`:
```
{ v: 1, enabled: false, lengthMinutes: 660, switchHourUtc: null, recordingsPlaylist: null | { id, title } }
```
- **`lengthMinutes`:** 15–705. The default is 660 (11 h). 15 is allowed so acceptance can use 15-minute segments.
- **`switchHourUtc`:** optional, 0–23. When set, a segment that would end within the next 2 h ends at that hour instead, so the
  switch happens in a quiet hour. **This applies only while the segment stays under 705 min**: a later quiet hour never pushes a
  segment past 12 h, and the segment then switches at its own length.
- **The recordings' visibility** is the stream's privacy: a recording is the segment's own video.
  - FO-REQ-0032 §3.2 asks for a separate setting. One video cannot have two privacies, so the stream's privacy field is relabelled
    to say it also applies to the recordings.
  - The app never changes a recording's privacy afterwards.
- **Turning segments off:**
  - the live broadcast is never ended;
  - the stream continues as one broadcast;
  - nothing else changes.

### 2.2 The switch (`segments.ts`, called from the runner's tick; a per-channel lock shared with Start/Stop)

1. **When.** Due when the stream is on, segments are on, the current broadcast has been live for at least `lengthMinutes` (or
   the quiet hour applies), and today's switch count is under the cap. The cap is 6 per channel per UTC day.
2. **Who.** Credentials of the channel's connected account (`channels.connected_user_id`), the identity check
   (`assertWriteChannel`, expected channel), and Live writes. Each write goes through the gateway, which checks Live writes right
   before it.
3. **Insert N+1.** The same fields as Start: the template is the stream's saved title, description, privacy, made-for-kids, saved
   broadcast settings, and `recordFromStart: true`. Then `enableAutoStart: false` and `enableAutoStop: false` (the app makes it
   live itself). Then bind it to the same stream.
4. **Make N+1 live.** Transition N+1 to live and poll every 3 s until it is `live`, for at most 5 min. "Redundant transition"
   counts as done.
5. **Hand over.**
   - Only once N+1 is `live`: record `broadcastId = N+1` on the stream, then transition N to complete.
   - Read both broadcasts, and log the segment rows and the measured overlap/gap.
   - The order matters: the stream row points at N+1 before N is ended. So the runner's ended-broadcast check (§1.3) never
     takes N's end for the stream's end.
6. **Afterwards.**
   - The video settings go to N+1 (BL-186 stage 3, in the background).
   - N's recording goes into `recordingsPlaylist`. It is retried every 10 min for up to 2 h, then given up with a notice.
7. **Failure.**
   - When N+1 is not created, not bound, or not live within 5 min, **N stays live** and is never ended.
   - An N+1 that never went live is deleted (`videos.delete`, 50 units) so no empty broadcast is left behind.
   - The event `live_segment_switch_failed` is logged and a bell notice shows it for 24 h. The next attempt is 30 min later.
   - Each failed attempt counts towards the daily cap.
8. **Never two live broadcasts** of one channel for longer than one switch.
   - Before step 3 the switcher writes a marker on the stream: `switching: { startedAt, newBroadcastId? }`, with the new id added
     as soon as the insert returns. The marker is cleared after step 5 or after the failure path.
   - A tick that finds a marker with no switch running in this process (a crash or restart mid-switch) repairs it from the new
     broadcast's state:
     - `live`, and the stream row names it: the old broadcast is completed;
     - `live`, and the row still names the old one: the new one is completed;
     - `ready`, `created` or `testing`: the new one is deleted;
     - gone: nothing.
   - Then the marker is cleared.
   - **As built (second review):** the marker has phases (`going_live`, `handover`, `cleanup`). A `handover` marker whose row still
     names the old broadcast (a crash between the two writes) moves the row first, then ends the old one. A `handover` marker
     found after the owner's Stop (intent off, or the row names a third broadcast after a new Start) ends the new one too and
     hands nothing over (`live_segment_switch_cancelled`).
   - Ending the old one and cleaning up the new one are retried with a pause of 1 min that doubles up to 1 h; nothing, the
     identity check included, is called inside the pause. A broadcast not live yet is read again only after 5 min.
   - Start keeps its own lock (it may copy the buffer for minutes). Stop, Go live and Edit take the stream's broadcast lock; a
     switch step never waits for it and is skipped when it is busy.
9. **The old segment's video settings may still be applying** when the switch replaces it. Its remaining steps are skipped as
   `broadcast_replaced` (not `stream_stopped`), and N+1 gets its own application after the switch.

### 2.3 Records (schema v99, `live_stream_segments`, local)

- **Columns:** `id`, `channel_id`, `broadcast_id`, `started_at`, `ended_at`, `switch_overlap_ms`,
  `rotation_json` (video ids played, from the helper's status), `recording_status`
  (`none|recorded|processing|failed`), `playlist_status` (`none|added|failed`), `failure`.
- **Retention:** keep all. Deleting or hiding old recordings (FO-REQ-0032 §3.3) is **not built**; that is a later decision.

### 2.4 Web UI

- The settings card gets a section «Перезапуск эфира»:
  - on/off;
  - the segment length;
  - the quiet hour;
  - the recordings playlist (chosen from the channel's playlists, as the stream settings already list them; a playlist is
    created in the Playlists screen).
  - A note: a viewer of the old segment is not moved automatically; `youtube.com/@<handle>/live` always opens the current one.
- The status card shows the current segment ("сегмент с HH:MM, следующее переключение около HH:MM") and the last switch's result.
- A segments table lists the last 30 days: start, end, recording, playlist, and failures.

### 2.5 Operator (MCP)

- `factory_live_get_status` gains `segments`: whether they are on, the length, the current segment, and the last 30 days with the
  §2.3 fields. Read only.
- Factory API goes to **1.25.0** (additive).
- A DEV-REL for the Operator is written at release.

### 2.6 Not built (said to the Operator)

- **2.B, a second stream/encoder:** not needed (spike D: no gap).
- **2.A, Live Redirect:** no API.
- **2.D, the "continues here →" line:** skipped. The old segment's page is a recording, and the link would cost 50 units per switch.
  It can be added on request.
- **§3.3 retention.**
- **The «Создать плейлист» button:** the Playlists screen already creates playlists.

## 3. Acceptance criteria (written before the code)

**Automated (fakes; expected values from this plan):**
- **AC-SEG-01.** Due only when on, segments on, the broadcast live for ≥ `lengthMinutes`, and under the daily cap. The quiet hour
  moves a switch due within 2 h to that hour, but never past 705 min of segment. Off or under length: no call at all.
- **AC-SEG-02.** The happy path, in order:
  1. insert (`recordFromStart: true`, the template's fields, auto-start off);
  2. bind (the same stream id);
  3. transition N+1 live, polling until live;
  4. the stream row → N+1;
  5. transition N complete;
  6. a segment row for N with its end, and for N+1 with its start;
  7. the video settings scheduled for N+1.
- **AC-SEG-03.** If N+1 does not go live within 5 min:
  - N is never transitioned;
  - the stream row keeps N;
  - N+1 is deleted;
  - the event `live_segment_switch_failed` is written and the bell notice is shown;
  - the next attempt is not before 30 min.
- **AC-SEG-04.** An insert or bind refusal is handled like AC-SEG-03; there is nothing to delete when the insert failed.
- **AC-SEG-05.** Live writes off or a wrong channel: no call. A failure is recorded once, not every tick.
- **AC-SEG-06.** Turning segments off while live ends nothing. The next tick makes no write.
- **AC-SEG-07.** The runner's ended-broadcast check never stops the stream because the old segment completed.
- **AC-SEG-08.** The recordings playlist:
  - N goes in after its switch;
  - a failure is retried every 10 min for up to 2 h, then marked `failed`;
  - nothing is added when no playlist is set.
- **AC-SEG-09.** Recovery from a marker left mid-switch. Each case leaves exactly one live broadcast:
  - new `live` and the row names the new one: the old one is completed;
  - new `live` and the row names the old one: the new one is completed;
  - new `ready`: deleted;
  - no new id: the marker is cleared and nothing else happens.
- **AC-SEG-13.** If the old segment's stage-3 application is still running when the switch replaces it, its remaining steps are
  skipped as `broadcast_replaced`.
- **AC-SEG-10.** The daily cap of 6 counts successes and failures, per channel, per UTC day.
- **AC-SEG-11.** MCP: `factory_live_get_status` returns `segments` with codes only (no key, URL or error text). Factory API is
  1.25.0.
- **AC-SEG-12 (as built: the playlist's ownership is checked by playlist-management at the add, not at save).** The settings validation:
  - the length is 15–705;
  - the hour is 0–23 or null;
  - the playlist must be one of the channel's own (checked at save, from the playlist list).
- **Locales:** every new text in English and Russian.

**With the owner (FO-REQ-0032 "Acceptance"):**
- Tropico, unlisted: 3 segments × 15 min. The encoder is never restarted, and each switch is logged with its overlap. Each
  recording appears and lands in the chosen playlist.
- A simulated failed switch (the insert refused, in a test build) keeps the old segment live and shows the bell notice.
- Turning segments off returns to one broadcast without ending the live one.
- The quota per switch and per day is reported from the ledger.
- The test fits under the daily cap of 6: 3 segments are 2 switches, plus 1 simulated failure, makes 3. A repeat of the test on the
  same day still fits. The owner is told this before the test.
