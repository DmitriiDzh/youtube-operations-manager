# Live streams: a channel's 24/7 loop of its own published videos (BL-176, FO-REQ-0019)

**Status: BUILDING** on `feature/live-streams` (owner's go, Telegram 2026-10-12, msg 2575). Storage is a rolling buffer, the
owner's own proposal (§2.2). Real YouTube tests still wait for a separate "да" (§2.3).

- Request: FO-REQ-0019 (Operator, 2026-10-11).
- Owner's assignment: Telegram 2026-10-11, msg 2572 ("возьми в работу REQ-0019").
- Reply to the Operator: DEV-RESP-0022.
- Owner's answers: msg 2575 (2026-10-12). The buffer details proposed in msg 2577 were accepted in msg 2578 ("ок").

## 1. Facts (code read 2026-10-11 at `dev` 5f81da1; the Mac read-only; YouTube docs read 2026-10-11)

### 1.1 The app today
- **No live code.** Nothing in `src/` calls `liveBroadcasts` or `liveStreams`. `videos.live_broadcast_content` is only read.
  - The write-gateway inventory regex already covers `liveBroadcasts|liveStreams` and `bind|transition`
    (`gateway-inventory.test.ts:86-87`).
  - A new gateway primitive must also go into `WRITE_PRIMITIVE_NAMES` (:116-124), or its "calls
    `assertLiveWritesAuthorized` first" check does not cover it.
- **Quota.**
  - `DATA_API_UNIT_COSTS` (`youtube-quota/costs.ts:8-40`) has no live rows, so a live call would be logged with `units` NULL
    ("unknown").
  - `isWriteMethod` (:63-64) matches only `insert|update|delete|rate`, so `bind` and `transition` would not count as writes.
- **Scopes.** Both stored sign-ins on the Mac carry `youtube` and `youtube.force-ssl` (`users.oauth_scope`, read-only), for
  Tropico Jazz and for Rural Japan Music. No reconnect is needed.
- **Live writes.**
  - Off at every boot (`instrumentation.ts:59`).
  - Under the Mac service, switched off after 10 idle minutes (ADR 0032 §4).
  - So no YouTube write can happen unattended. That is the rule this plan keeps.
- **Only video-details has the full safety chain:** dry run, identity, backup, etag conflict, audit, read-back
  (`video-details/services.ts:104-268`).
- **Child processes.** The app starts none except a browser for sign-in. No ffmpeg dependency.
  - Boot sweeps fail or interrupt work. Nothing is restarted as "should be running".
- **Secrets.**
  - Device-local secrets are encrypted with a per-device key file (`device-key-file`; RunPod, Gemini).
  - The tables holding them are excluded from snapshots.
  - Nothing scrubs secrets from logs, except `redactPodEnv` for RunPod pod env.
- **Two computers.**
  - Per-device report families (ADR 0028 pattern, `sync-gateway/per-device-report`). Families are registered in code
    (`run-all-families.ts`), so an older build never reads a family it does not know.
  - The UI names the other computer `hostname ?? deviceId`.
- **Video ↔ local file.**
  - The app has no map from a videoId to a local file.
  - Duration alone cannot build one. Of Tropico's 21 local files, 9 match exactly one YouTube video within ±1 s; 12 match
    two or three.
  - The only match for V55 is a **private** video.
- **UI.**
  - Content has no sub-tabs (`content/page.tsx`). Sub-tab lists live in `section-tabs.ts`.
  - Settings has RunPod and Gemini sub-tabs for host settings.
  - The header bell's notice kinds are a union in `device-sync/contracts.ts:37-53`.
- **No free-disk check exists.**

### 1.2 The Mac (Mac16,10, M4, macOS 15.7.4; read-only checks)
- **ffmpeg.** Homebrew `ffmpeg-full` 9.0.2 is installed. It has `rtmps` (GnuTLS), `h264_videotoolbox` and libx264.
- **Disk.**
  - Internal: 228 GB, **30 GB free**.
  - T9 (Samsung T9, USB, APFS, not encrypted): 1.6 TB free, but it mounts only at the first login after a restart (ADR 0032
    consequences), and it disconnected by itself on 2026-10-08.
  - `AutomountDisksWithoutUserLogin` is not set (`/Library/Preferences/SystemConfiguration/autodiskmount` does not exist). Whether
    setting it mounts the T9 at boot on macOS 15 is **unverified**; it is an admin step outside this plan.
- **Local published videos:** 21 files per channel, 23.0 GB (Tropico) and 24.1 GB (Japan).
- **Format of the published videos** (V55 Tropico, V47 Japan, V35 Tropico):
  - 1920×1080, 30 fps, H.264 High at 0.59–0.64 Mbit/s;
  - AAC-LC 48 kHz stereo at 0.29–0.31 Mbit/s;
  - keyframes every 8.33 s;
  - ~7,200–7,290 s each.
- **What the picture is.** A fade-in and an animated "subscribe" overlay in the first ~15–20 s, then **one still picture**:
  - In V55, the frame at 1,830 s matches the frames at 20 s, 40 s, 120 s, 3,600 s, 7,100 s and 7,280 s at PSNR 41 dB, which
    is compression noise.
  - The mean difference between consecutive frames is 0.01/255.
  - P-frames are about 1 KB, B-frames about 0.4 KB, I-frames about 529 KB.
- **Upload:** 19.7 Mbit/s over Wi-Fi (the Operator's measurement).

### 1.3 YouTube (official docs unless marked)
- **Quota.** The Quota Calculator (updated 2026-10-08) lists every `liveBroadcasts` and `liveStreams` method at **1 unit**,
  `videos.list` at 1. The live rows first appear in that version, so check the Cloud Console after the first calls.
- **Stream.**
  - A reusable `liveStream` (the default) serves all of a channel's broadcasts.
  - `cdn.ingestionInfo` returns `rtmpsIngestionAddress` and `streamName` (the key).
  - OBS re-reads the key with `liveStreams.list part=cdn`, so the key need not be stored. Official text does not promise
    this; it is checked in spike B.
  - No API method resets a key.
- **Broadcast.**
  - `insert` needs title, `scheduledStartTime` (in the near future) and privacy.
  - `enableAutoStart` and `enableAutoStop` default to false.
  - With `enableMonitorStream: false` there is no testing stage: auto-start or `transition live` goes straight to live.
  - `bind` attaches the stream; `transition complete` ends the broadcast.
- **Gap behaviour (the key question).**
  - `enableAutoStop: true` ends the broadcast about one minute after data stops.
  - With `enableAutoStop: false`, **no source says whether a 2- or 10-minute gap keeps the same broadcast live.** Community
    reports disagree.
  - **UNVERIFIED.** Spike B measures it.
- **Ingest.**
  - H.264, keyframes every 2 s (at most 4 s), closed GOP, CBR.
  - 1080p30 H.264 needs **at least 5 Mbit/s**.
  - AAC at 44.1 or 48 kHz.
  - RTMPS on port 443.
- **Limits.**
  - Streams over 12 h are not archived, and DVR may be limited.
  - No maximum broadcast length is documented, and YouTube's own docs use a 24/7 feed as an example.
  - 10 active streams per channel, 3 per key.
- **Policy.** No rule found that bans looping one's own uploads, and none found that requires a label. Monetization's
  "reused / inauthentic content" judgement is the owner's and the Producer's call.

### 1.4 Measured encoder options (60 s runs on the Mac, no network)
- **Re-encoding the original MP4 live** (`h264_videotoolbox`, 6 Mbit/s CBR, 2 s GOP, audio copied): 14.6 s CPU per 60 s, about
  24 % of one core.
- **Encoding live from a prepared source** (audio copied; picture at full rate for the opening seconds, then one frame a
  second; the encoder repeats frames to 30 fps): 4.4 s CPU per 60 s, about 7 % of one core. Output was CBR with a keyframe
  every 2.0 s.
- **The concat demuxer opens each later file only when it reaches it** (2026-10-12, 4 s test clips, `-re`, `-c copy`): a file
  created while the one before it played was played in full.
- **A missing next file ends the input quietly.** ffmpeg logs `Impossible to open '<file>'` and `Error during demuxing`, then exits
  with **code 0**, the same as a normal end of the list.
- **Not in the encoder's command line.** ffmpeg prints the full output URL, key included, in its banner and in connection
  errors. Its command line is readable by **every account on the Mac** (`ps`: other users' arguments are visible, checked).
  `-/rtmp_playpath <file>` is not accepted ("Option not found").

## 2. Decisions for the owner

### 2.1 Scope
- Lift the §58 non-goal "livestream management" for one case: **a loop of a channel's own public videos, sent from the Mac**.
  This is recorded as ADR 0036 and a note under §58.
- Out of scope: live generation, chat, hosted services, streaming from Windows.

### 2.2 What sits on the Mac's internal disk
The T9 is not readable after an unattended restart until someone logs in, and it has disconnected by itself. So a stream needs
its next files on the internal disk (30 GB free).

| Option | Size, both channels | Fits 30 GB | Needs the T9 |
|---|---|---|---|
| (a) All original files | 47.1 GB | no | no |
| (b) "Stream-ready copies" (request §C), 2 s GOP | ≈ 92 GB (≈ 200 GB at CBR 5 Mbit/s) | no | no |
| (c) All prepared sources (audio + one frame a second) | ≈ 14 GB | yes | only while preparing |
| **(d) Rolling buffer of originals (chosen)** | depth 2: ≈ 4.5 GB; depth 4: ≈ 9 GB | yes | every ~2 h |

**Decided (owner, msg 2575):** keep only the video now playing and the next one on the internal disk, and rotate the files.
Details (proposed in msg 2577, accepted in msg 2578):
- **The buffer holds copies of the originals**, not prepared sources. The picture is re-encoded live (≈ 24 % of one core per
  stream, §1.4). No preparing step and no still-picture check, so videos whose picture moves work in phase 1.
- **Depth is a setting**, default 2 (the video playing and the next one). Each original is ≈ 1.1 GB.
- **The T9 becomes a running dependency.** Each new video is copied from it about every 2 h. After an unattended restart the
  stream resumes from the buffer, and the buffer gives about 2–4 h at depth 2.
- **When the next file cannot be copied** (T9 missing, file missing, disk too full), the stream does not stop. It replays the
  videos already in the buffer, and the bell shows a notice. The rotation resumes once the T9 is back.

### 2.3 Real YouTube tests
- Spike B and the acceptance run write to YouTube on Tropico, as an **unlisted** broadcast with the owner present.
- That needs the owner's separate "да" (AGENTS.md §K.4), Live writes switched on, and live streaming enabled in Studio. The last
  is the owner's step; it can take up to 24 h.

## 3. Design

### 3.1 Rules (ADR 0036)
- **The owner's "on" is a saved intent.** While a stream is on, the app keeps its local encoder running: after a crash, a
  network drop, a server restart or a Mac restart.
- **Restarting the encoder is not a YouTube write.**
- **The app never writes to YouTube by itself.** Creating, binding, starting, ending or editing a broadcast happens only when
  the owner presses a button, with Live writes on.
- **A running stream does not keep Live writes on.** It does not count as "busy" for the idle watcher (`isBusy`, unlike open
  pods), so Live writes still switch off after 10 idle minutes (ADR 0032 §4, RISK-09). The encoder and the status polls need
  no session.
- **ADR 0029 §4 is untouched.** It governs generation plans; this is a separate rule for streams only.
- **Hosting.**
  - Only on the Mac running as the system service (`YTOM_SERVICE_MODE=1`), with the module switched on in Settings (off by
    default; §M).
  - Every other computer shows streams read-only.

### 3.2 Module layout (AGENTS.md §G, §M)
- **`src/lib/live-streams/`** (contracts, schemas, services, adapters): streams, rotation, the buffer, status, events.
  - Switched off: no timers, no processes. Every other screen works as before.
- **`src/lib/ffmpeg-host/`**: the one place that finds ffmpeg, checks its features (`rtmps`, `h264_videotoolbox`, libx264) and
  spawns it.
  - Every ffmpeg line it hands on passes its scrubber first (§3.7).
- **Write gateway, new primitives** (each added to `WRITE_PRIMITIVE_NAMES`):
  - `insertLiveStream`;
  - `insertLiveBroadcast`;
  - `bindLiveBroadcast`;
  - `transitionLiveBroadcast`;
  - `updateLiveBroadcast`.
- **Read gateway, new reads** in `data-api.ts`:
  - `listLiveStreams` (status, cdn);
  - `listLiveBroadcasts` (status, snippet);
  - viewers through `videos.list part=liveStreamingDetails`, batched over channels.
- **Quota.**
  - 11 rows at 1 unit: `liveBroadcasts` list, insert, update, delete, bind, transition, insertCuepoint; `liveStreams` list,
    insert, update, delete.
  - `isWriteMethod` gains `bind|transition|insertCuepoint`.
  - The quota context kind is `live_stream`.
- **Errors in plain words:**
  - `liveStreamingNotEnabled`: "enable live streaming in Studio, it can take up to 24 h";
  - `livePermissionBlocked`;
  - `insufficientLivePermissions`;
  - `invalidScheduledStartTime`;
  - `errorStreamInactive`;
  - `invalidTransition`;
  - `redundantTransition`, which counts as done;
  - `liveBroadcastBindingNotAllowed`;
  - `concurrentBroadcastsExceedLimit`.
  - Everything else falls back to today's `update_failed`.

### 3.3 Data (schema v86, device-local, excluded from snapshots)
- **`live_streams`** (one row per channel):
  - the owner's intent (`on|off`);
  - the YouTube stream and broadcast ids;
  - title, description, privacy, `madeForKids`;
  - order (`sequence|shuffle`);
  - the current pass's position;
  - `on_since`.
- **`live_stream_videos`** (the rotation, one row per video):
  - `video_id`, the original's path (relative to the channel workspace);
  - durations (the video's and the original's);
  - the check result;
  - the owner's override of the public-only guard, with its reason;
  - the position in the rotation.
- **`live_stream_events`**, one row per event:
  - writes (dry-run preview, before/after, result, read-back verification);
  - encoder starts, exits and restarts (cause, gap);
  - YouTube status changes;
  - interruptions (start, end, cause).

  `detail_json` is scrubbed. This table is the audit trail and the history the page shows.
- **`live_stream_sources`**: the Operator's `{ videoId → original path }` map (§3.4).

### 3.4 Rotation and the public-only guard (request §B)
- **Adding a video.** The owner picks a video from the channel's list, with the newest public first.
  - The file is the one the Operator mapped. Otherwise the owner picks it among files in the channel workspace whose duration
    is within 1 s.
- **The guard.** A video may enter, and stay in, a rotation only if YouTube says it is `public` and has no future `publishAt`.
  - The app **re-reads** the rotation's videos (`videos.list`, 1 unit per 50 ids) when a video is added, at every Start, and
    at every encoder restart.
  - The synced copy can be 20 minutes stale, so it is not trusted for this.
  - A video that stops being public leaves the next pass, and an event records it.
  - The owner's explicit override, with a reason, is allowed and audited.
- **The Operator's map.**
  - Factory MCP tool `factory_live_map_sources { channelId, items: [{ videoId, file }] }`, where `file` is relative to the
    channel workspace.
  - The app checks each item:
    - the file exists inside the workspace;
    - its duration is within 1 s of the video's;
    - the video is public.
  - It returns a result per item. The map only offers files; the owner builds the rotation.
- **Not touched:** the channel's `mix_history.csv` and every other workspace file.

### 3.5 The buffer (request §C, option (d))
- **Where:** `<appData>/live-streams/<channelId>/`, on the internal disk.
- **What:** the video now playing and the next `depth − 1` videos of the pass, as copies of the originals.
- **Copying** runs in the background while the stream plays:
  1. copy the original from the T9 to `<videoId>.mp4.part`;
  2. check the copy:
     - its size matches the original's;
     - its duration is within 1 s of the YouTube video's;
     - its audio is AAC at 44.1/48 kHz with at most 2 channels;
  3. rename it to `<videoId>.mp4`. The encoder never sees a file under its final name before it is complete.
- **Deleting:** a copy is deleted only after the encoder has moved past it **and** the copies that replace it are in place, so
  with the T9 gone the buffer still holds `depth` videos to replay. The file now playing is never deleted; it is the resume
  point after a restart. Only a copy refused for disk space frees the unwanted copies first and tries again.
- **Replaying** uses only buffer files whose videos are still playable (§3.4): a video that turned private is never replayed.
- **When the next file cannot be copied** (the T9 is not mounted, the original is gone, a check fails, or the copy would leave
  less free space than the refuse level):
  - the stream keeps replaying the videos already in the buffer, in their order;
  - an event records the cause, and the bell shows `live_stream_source_missing`;
  - copying is retried every few minutes. Once the next file is in place, the rotation resumes at the next run.
- **Disk.**
  - The page shows the buffer's size per channel and the free space.
  - A warning appears under 10 GB free.
  - Copying refuses a file that would leave under 5 GB. Both thresholds are settings.
- **Adding a video to the rotation** needs the T9 mounted: the original must exist, and its duration must be within 1 s of the
  YouTube video's.

### 3.6 Encoder and supervision (request §F)
- **Encoder (final flags from spike A).**
  - Input: the concat demuxer over buffer files (`-re`). Shuffle draws a new order for each pass.
  - **An early end is never a pass end.** ffmpeg exits with code 0 when a listed file is missing (§1.4). So the helper compares
    the run's last `out_time` with the length of its list. A run that ended early counts as `source_missing`, never as the end of
    a pass.
  - **A run lists the whole pass** and relies on lazy opening (§1.4, §6): no reconnect between videos. The next copy is made
    right after the encoder enters a video, about 2 h before it is needed; a copy takes 1–2 s.
  - Video: the original decoded → `fps=30` → H.264, 2 s GOP, no B-frames. **The encoder and bitrate wait for spike B (§6.1):**
    `h264_videotoolbox` does not pad to CBR (≈ 2.2 Mbit/s), and libx264 CBR at 6 Mbit/s costs ≈ 52 % of one core.
  - **Resume:** `inpoint` is set to the source keyframe at or before the resume point (found with ffprobe), so the run starts
    exactly at its `inpoint` and the now-playing arithmetic of §4.1 holds.
  - Audio: copied.
  - Output: FLV to the stream's `rtmpsIngestionAddress`.
  - Progress: `-progress pipe:1` every 5 s.
- **The encoder helper.** A small node process, started detached from the server so it survives server restarts.
  - It runs ffmpeg and restarts it when it exits, with a backoff of 2, 4, 8, 16, 32, then 60 s. A run of 10 minutes or more
    resets the backoff.
  - It resumes inside the video that was playing (`inpoint`).
  - It writes a scrubbed status file: state, pass, position, bitrate, sent bytes, dropped frames, restarts.
  - The server adopts a running helper at boot (pid and protocol version), or starts one.
  - The helper gets the key from the server on stdin, never from a file.
- **At the end of a pass,** ffmpeg exits and the next pass starts. That is a reconnect of a few seconds about every 42 h.
- **After a Mac restart.** The service starts the server, and the server finds streams marked `on`. For each, it:
  1. re-reads the key (`liveStreams.list`, a read, which Live writes do not gate);
  2. starts the helper.

  The buffer is on the internal disk, so the stream resumes without the T9. The rest of the buffer is its runway until someone
  logs in and the T9 mounts (§3.5).
- **Intended: `stop.sh` and the server restarts after merges leave a running stream alone.** If spike A shows that launchd kills the
  helper with the job, the plist gains `AbandonProcessGroup` (one reinstall, one admin password).
- **Recorded per stream:** restarts with cause and gap, bytes and bitrate, dropped frames.

### 3.7 The stream key (request §E)
- **Never stored.** It is read from YouTube at each helper start (1 unit), kept in the helper's memory, and passed to ffmpeg.
- **Fallback.** If spike B shows that `liveStreams.list` does not return `streamName`, the key is stored the way the Gemini key
  is: encrypted with the device key file, and kept out of snapshots.
- **The UI shows only** "the key comes from YouTube" and the last 4 characters.
- **The scrubber** replaces the key, and any `rtmp(s)://…` path after the host, before a line reaches:
  - the helper's status or log file;
  - an event;
  - the server log;
  - an error shown in the UI.

  ffmpeg runs without `-report` and below debug log level.
- **Never** in snapshots, per-device reports, the sync folder or MCP output.
- **Residual risk (new RISK entry).** The key is in ffmpeg's command line, which the other account on the Mac can read with
  `ps`. That account already has the channels' Google sign-in (ADR 0032, msg 2152), so it is not a new capability. It is still
  recorded.

### 3.8 Recovery without a YouTube write (request §H)
- **After every encoder (re)start, the app reads the broadcast** (`liveBroadcasts.list`). That is also the 5-minute poll.
  - **`live`:** the same broadcast continued. An event notes the gap.
  - **`complete` or `revoked`:** YouTube ended it.
    - The encoder stops.
    - The stream shows "ended by YouTube — start a new broadcast".
    - A bell notice appears.
    - **No write is made.** The owner presses Start (new broadcast, new link).
- **Phase 2 only, if spike B shows that YouTube ends broadcasts across short gaps:** a scoped standing approval ("this stream,
  same settings, at most N new broadcasts a day, each audited"), with its own ADR. It is not designed here.

### 3.9 Attended actions (request §A, §D)
- **Start.**
  - Preconditions:
    - Live writes on (the dialog links to the switch);
    - the identity check (`assertWriteChannel`);
    - every rotation video still public, and the first `depth` videos of the pass in the buffer;
    - ffmpeg checked;
    - free disk above the warning level.
  - The dialog is the dry run. It shows exactly what will be sent: title, description, privacy, made-for-kids, auto-stop off,
    and the units (5 on the first Start, 4 after).
  - On confirm:
    1. `liveStreams.insert`, first time only;
    2. `liveBroadcasts.insert` (auto-start on, auto-stop off, monitor stream off, start time now + 2 min);
    3. `bind`;
    4. key read;
    5. the helper starts.
  - The app then polls every 15 s until the broadcast is `live`.
  - If the stream is `active` but the broadcast is not live after 3 minutes, the app calls `transition live`. That is still the
    owner's action, with Live writes still on.
  - **As built (2026-10-12):** this is a «В эфир» button the owner presses, with its own dialog, not a call the app makes by itself
    three minutes later: a delayed background write would happen after the owner's click, maybe after Live writes changed. Spike B
    shows whether auto-start makes it needed at all.
- **Stop.**
  1. `transition complete` (a write);
  2. the encoder stops;
  3. intent goes to `off`.

  With Live writes off, the dialog offers to switch them on. Its other choice, "stop the encoder only", warns that the
  broadcast stays open on YouTube without a picture until it is ended there.
- **Restart:** the encoder restarts on the same broadcast. No write.
- **Edit title, description or privacy.**
  1. A preview of before and after.
  2. `liveBroadcasts.update`.
  3. Read back.
  4. An event holds both versions, which is the backup.
- **Edit the rotation:** local only, applied at the next pass, or now with "Restart".

### 3.10 Status, history, alert (request §G)
- **State** comes from:
  - the helper (running, restarting, last exit);
  - YouTube, every 5 minutes, and every minute for 10 minutes after a restart (the owner's Start included; about 30 units more per
    restart):
    - broadcast `lifeCycleStatus`;
    - stream `streamStatus`;
    - `healthStatus` with its `configurationIssues`;
    - viewers.
- **States shown:** off / starting / live / live, replaying the buffer (the T9 or a file is missing) / reconnecting / ended by
  YouTube / error.
- **Quota (as built).**
  - A running stream costs 3 units a poll (broadcast, stream status, viewers while live): 288 polls × 3 = 864 a day.
  - Two channels: about 1,728 units a day, out of 10,000. (The plan first had one viewers call for all channels; it is one per
    channel, which keeps each stream's poll independent.)
- **History:** interruptions with start, end and cause.
- **Bell notices:**
  - `live_stream_down`: the encoder or YouTube has not been live for more than 5 minutes (a setting);
  - `live_stream_ended`: YouTube ended the broadcast;
  - `live_stream_source_missing`: the next video could not be copied, and the stream is replaying the buffer (§3.5).

### 3.11 Two computers (request §I phase 1) and the Operator (request §J)
- **New sync family `live-streams`** (per-device report v1, ADR 0028 pattern). The Mac publishes per channel:
  - state, since, uptime;
  - the video now playing and its index of N;
  - health, and issue types only;
  - whether it is replaying the buffer;
  - the last interruption (times and a cause code);
  - viewers.

  It never carries a key, a URL, an ingestion address or error text.
- **Windows** shows the same page read-only, about 1–2 minutes behind, with "на <Mac>" in place of the buttons.
  - A new family needs no lockstep update. Windows sees streams once it updates.
- **Factory MCP `factory_live_get_status`** (read-only, in phase 1): the same fields. (Named `get` like the other reads; the map
  tool of §3.4 is `factory_live_map_sources`.)
  - The app cannot reach Telegram, so this is how the Operator learns at night that a stream is down.
  - Factory API 1.14.0, additive.

### 3.12 Screens (as a UX designer: audit first, then build)
- **Content gets sub-tabs, «Видео» (today's list) and «Трансляции».** `/content` keeps opening «Видео».
- **«Трансляции»: the active channel's stream** (channel routes are scoped to the active channel, ADR 0004; the bell's notices
  switch to the channel). A computer that cannot host streams shows only the other computers' reports, read-only.
  - State badge, uptime, now playing (N of M), health and viewers.
  - Start / Stop / Restart.
  - Texts and privacy.
  - The rotation: list, order, add, remove, checks, the buffer and disk.
  - History.
- **Settings → «Трансляции»** (this computer):
  - the module switch;
  - ffmpeg (detected path and features);
  - buffer folder, buffer depth and disk thresholds;
  - bitrate;
  - alert minutes.
- Every text in English and Russian.

## 4. Acceptance criteria (fixed before the code)

### 4.1 Automated (derived from the request and the YouTube docs, not from the code)

**Guard**
- `public` with no `publishAt` → allowed.
- `public` with a past `publishAt` → allowed.
- `private`, `unlisted`, or `public` with a future `publishAt` → refused with the reason.
- An override needs a reason and leaves an event.

**Scrubber**
- With a fake key `k3y-TEST-0000`, every sink is searched for the string after a run in which ffmpeg prints its banner and a
  connection error. It appears 0 times. The sinks:
  - the status file;
  - the log;
  - `live_stream_events`;
  - the server log;
  - the API error;
  - the sync report;
  - the MCP output.

**Quota**
- Each of the 11 live methods costs 1.
- `bind` and `transition` count as writes.
- Before its first status poll, a first Start costs 5 units: `liveStreams.insert`, `videos.list`, `liveBroadcasts.insert`,
  `bind`, `liveStreams.list`.
- A later Start costs 4.

**Gateway inventory**
- The 5 new primitives are in `WRITE_PRIMITIVE_NAMES`.
- Each caller calls `assertLiveWritesAuthorized` first.
- Live writes off → each Start, Stop and Edit write is refused, and the encoder is not started.
- A stream is running and nothing else is busy. After 10 minutes with no window and no agent request, Live writes read off.

**Recovery**
- Consecutive exits wait 2, 4, 8, 16, 32, 60 and 60 s before the next start.
- A run that lasted 10 minutes or more resets the wait to 2 s.
- A broadcast read as `complete` → no write call, the encoder stopped, a `live_stream_ended` notice.

**Alert**
- With the down threshold at 5 min: down at 10:00:00 → no notice at 10:04:59, a notice at 10:05:00.

**Buffer** (rotation A, B, C, depth 2)
- While A plays, the buffer holds A and B.
- After the encoder moves to B, A is deleted and C is copied. B is never deleted while it plays.
- A copy is visible under its final name only after it is complete and checked. An interrupted copy leaves only a `.part` file,
  which is never listed.
- A copy that would leave less than the refuse level free is not started.
- The T9 is missing when C is due:
  - A and B stay in the buffer (A is not deleted until C is in place);
  - no YouTube write is made;
  - the run's early end is recorded as `source_missing`, not as a pass end;
  - the encoder goes on with the buffered videos;
  - a `live_stream_source_missing` notice appears.
- The T9 comes back → C is copied, then A is deleted, and the rotation resumes at the next run.

**Now playing**
- Rotation 7,288 / 7,211 / 7,224 s; one pass is 21,723 s.
- `out_time` 7,300 s → video 2 at 12 s.
- `out_time` 21,700 s → video 3 at 7,201 s (21,700 − 7,288 − 7,211).
- A pass resumed with `inpoint` 3,000 s on video 2 and `out_time` 5,000 s → video 3 at 789 s (3,000 + 5,000 − 7,211).

**Report**
- The strict schema rejects any extra field. No field can hold a URL or a key.
- An older build ignores the family.

### 4.2 On the Mac with the owner (request §4), Tropico, unlisted
- **Start.** A rotation of 3 public videos goes live within a few minutes. The page shows live, the video, uptime and
  `healthStatus` with its issues.
- **Guard.** A private or scheduled video is refused with a clear reason. V55 is private today and serves as the case.
- **Texts.** A title edit reaches YouTube through the gateway, with an event.
- **Network cut of 2 minutes.**
  - The stream comes back without the owner, and the interruption is in the history.
  - The record says whether the same broadcast continued.
- **Server restart (`stop.sh`):** the stream keeps running.
- **Planned Mac restart** (`fdesetup authrestart`), no one logs in: the stream comes back from the buffer.
- **T9 unplugged for longer than one video:** the stream stays live and replays the buffer; the history and the bell show it.
  Plugged back in: the rotation resumes.
- **Alert:** with the encoder stopped for more than 5 minutes, a notice appears in the bell.
- **Key.** The key string is found nowhere outside the helper's memory and ffmpeg's command line. Searched:
  - the UI;
  - every log;
  - the DB file;
  - snapshots;
  - the sync folder;
  - reports.
- **Quota:** `quota_ledger` shows the live calls at 1 unit each, and the Cloud Console agrees.
- **Windows:** the status appears within about 2 minutes, with "на Mac" in place of the buttons. This needs Windows updated.
- **Compatibility:** Languages, Content, Media and plans, Servers and Research behave as before. No YouTube write bypasses the
  gateway.

## 5. Build order (one branch, `feature/live-streams`, merged once on the owner's yes)
1. **Spike A, local only, no YouTube.** The helper and ffmpeg against a local RTMP listener. It checks:
   - how a run is listed (§3.6), and that an early end is told apart from a pass end;
   - copying into the buffer while the encoder plays, and deleting behind it;
   - the joins between videos and the pass wrap;
   - audio/video drift over a multi-hour run;
   - CPU of two streams re-encoding originals;
   - restart and resume with `inpoint`;
   - whether the helper survives a service restart under launchd;
   - the scrubber.

   It fixes the final flags.
2. **Gateway work, with tests:** write and read primitives, quota rows, error texts.
3. **Spike B, needs the owner's "да".** Real writes on Tropico, one unlisted broadcast, live streaming enabled in Studio. It
   checks:
   - whether the key is readable through `liveStreams.list`;
   - 2-, 10- and 30-minute gaps with auto-stop off, logging `lifeCycleStatus`, `streamStatus` and `actualEndTime` every minute;
   - the quota in the Cloud Console.

   Results go into §6 here and into ADR 0036.
4. **Data, sources map, the buffer, rotation and the guard.**
5. **Helper supervision, boot restore, recovery** (§3.8 with the spike B results).
6. **Screens, Settings and the bell.**
7. **Sync family and the Windows view; the MCP status and map tools; Factory API 1.14.0.**
8. **Finish:**
   - full suite, lint, build;
   - the §4.2 run with the owner;
   - independent review;
   - the owner's merge decision.

## 6. Spike results

### 6.1 Spike A (local, 2026-10-12; Tropico V41/V37 and Japan V47 originals; a local RTMP listener, no network)
- **Copying into the buffer:** 1–2 s per original (0.8–0.9 GB) from the T9 to the internal disk.
- **Joins:** V41 → V37 with re-encoding:
  - timestamps stay monotonic, and no gap is over 34 ms;
  - keyframes come exactly every 2.0 s;
  - audio and video end within 0.1 s of each other.

  At one join, ffmpeg corrected a 13 ms audio DTS overlap by itself (a warning only).
- **Lazy listing on real files:**
  - a next file renamed into place while the one before it played was played;
  - the finished file was removed after the join without any effect.
- **Bitrate. To decide in spike B.**
  - `h264_videotoolbox` with `-constant_bit_rate 1` gives only ≈ 2.2 Mbit/s on these still pictures, not CBR: it does not pad.
    It costs ≈ 11–12 % of one core per stream (Tropico V41; Japan V47 measured alongside another stream and an Operator render).
  - libx264 with `nal-hrd=cbr` holds 6.3 Mbit/s with 2 s keyframes, at ≈ 52 % of one core per stream.
  - YouTube recommends at least 5 Mbit/s for 1080p30. Two streams at 6 Mbit/s are ≈ 12.6 of the 19.7 Mbit/s upload.
  - Spike B shows what YouTube's health check says at 2.2 Mbit/s.
- **Resume with `inpoint`:** the run starts at the source keyframe before the in point. Source keyframes are 8.33 s apart, so a
  restart replays up to ≈ 8 s, and position math that ignores this pre-roll is off by as much.
- **Supervision (prototype helper):**
  - after a SIGKILL of ffmpeg at 20 s, the run restarted 2 s later at the same position;
  - with the listener down, the waits were 2, 4, 8 and 16 s.
- **Scrubber:**
  - ffmpeg prints the full output URL, key included, in its "Error opening output" lines.
  - After scrubbing, the fake key `k3y-TEST-0000` appeared 0 times in the helper's log and status file.
- **launchd** (a temporary LaunchAgent in the owner's GUI domain, not the system service). A helper spawned `detached` (its own
  process group):
  - survived the job's main process exiting and the job's restart;
  - survived `launchctl bootout`.

  A plain child was killed in both cases. So `AbandonProcessGroup` looks unnecessary. The §4.2 run with the real `stop.sh`
  confirms it on the system service.
- **Drift over a multi-hour run:** pending (a ≈ 3 h run across a join).

## 7. Not in phase 1
- **Phase 2:**
  - Stop, Start and rotation edits from Windows;
  - the broadcast thumbnail (`thumbnails.set`);
  - newly published videos added automatically (opt-in);
  - an optional split every ~11 h for archives;
  - the standing approval of §3.8, if needed.
- **Phase 3:**
  - a stream composed live (a looping clip, "now playing" on screen);
  - scheduled one-off streams and premieres.
