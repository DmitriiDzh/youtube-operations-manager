# Live streams: a channel's 24/7 loop of its own published videos (BL-176, FO-REQ-0019)

**Status: PROPOSAL.** Nothing is built. Building starts only on the owner's go. Two decisions are the owner's (§2).

- Request: FO-REQ-0019 (Operator, 2026-10-11).
- Owner's assignment: Telegram 2026-10-11, msg 2572 ("возьми в работу REQ-0019").
- Reply to the Operator: DEV-RESP-0022.

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
  - T9: 1.6 TB free, but it mounts only at the first login after a restart (ADR 0032 consequences).
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
- **Not in the encoder's command line.** ffmpeg prints the full output URL, key included, in its banner and in connection
  errors. Its command line is readable by **every account on the Mac** (`ps`: other users' arguments are visible, checked).
  `-/rtmp_playpath <file>` is not accepted ("Option not found").

## 2. Decisions for the owner

### 2.1 Scope
- Lift the §58 non-goal "livestream management" for one case: **a loop of a channel's own public videos, sent from the Mac**.
  This is recorded as ADR 0036 and a note under §58.
- Out of scope: live generation, chat, hosted services, streaming from Windows.

### 2.2 What sits on the Mac's internal disk
The T9 is not readable after an unattended restart until someone logs in. So a stream that must come back by itself needs its
files on the internal disk (30 GB free).

| Option | Size, both channels | Fits 30 GB | Picture |
|---|---|---|---|
| (a) The original files | 47.1 GB | no | as published |
| (b) "Stream-ready copies" (request §C), 2 s GOP, copied as is | ≈ 2.4 Mbit/s × 7,250 s ≈ 2.2 GB each, ≈ 92 GB | no | as published |
| (b') The same at CBR 5 Mbit/s (YouTube's 1080p30 minimum) | ≈ 4.8 GB each, ≈ 200 GB | no | as published |
| **(c) Prepared sources (recommended)** | audio ≈ 0.28 GB + picture ≈ 0.05 GB per video ≈ 14 GB | yes, 16 GB left | the opening ~30 s at full rate, then one frame a second of the same still |

- Option (c) keeps the published sound bit for bit. The picture is re-encoded from the original: the opening at full rate,
  then one frame a second, which on these videos is the same still.
- The app checks every video before using it:
  - a video whose picture moves after the opening (a real clip) is refused in phase 1;
  - its duration must match the YouTube video's within 1 s.
- The ~0.05 GB picture figure is from a 5-minute sample. The page shows the real size after preparing.
- Alternatives: free the disk and use (a), or stream fewer videos.

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
- **`src/lib/live-streams/`** (contracts, schemas, services, adapters): streams, rotation, prepared sources, status, events.
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
  - `video_id`, the original's path (relative to the channel workspace), the prepared file and its size;
  - durations (the video's and the prepared source's);
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
  - Factory MCP tool `factory_live_sources_set { channelId, items: [{ videoId, file }] }`, where `file` is relative to the
    channel workspace.
  - The app checks each item:
    - the file exists inside the workspace;
    - its duration is within 1 s of the video's;
    - the video is public.
  - It returns a result per item. The map only offers files; the owner builds the rotation.
- **Not touched:** the channel's `mix_history.csv` and every other workspace file.

### 3.5 Prepared sources (request §C, option (c))
- **"Подготовить" runs in the background**, one video at a time, and resumes after a restart. For each video it:
  1. reads the original from the T9, which must be mounted at that time;
  2. writes `<appData>/live-streams/<channelId>/<videoId>.mp4`:
     - the audio copied as is;
     - the picture at full rate for the first 30 s, then one frame a second, with libx264 at high quality.
- **Checks before a source is marked ready:**
  - duration within 1 s of the YouTube video;
  - AAC at 44.1/48 kHz, at most 2 channels;
  - the picture still after 30 s: 12 sample points, two consecutive frames each, mean difference under a fixed threshold.
- **Disk.**
  - The page shows each channel's size and the free space.
  - A warning appears under 10 GB free.
  - Preparing refuses a video that would leave under 5 GB. Both thresholds are settings.

### 3.6 Encoder and supervision (request §F)
- **Encoder (final flags from spike A).**
  - Input: the concat demuxer over one pass of the rotation (`-re`). Shuffle draws a new order for each pass.
  - Video: `fps=30` → `h264_videotoolbox`, CBR at the bitrate setting (default 6,000 kbit/s), 2 s GOP, no B-frames.
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

  The prepared sources live on the internal disk, so the T9 is not needed.
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
    - every rotation video ready and still public;
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
  - YouTube, every 5 minutes, and every minute for 10 minutes after a restart:
    - broadcast `lifeCycleStatus`;
    - stream `streamStatus`;
    - `healthStatus` with its `configurationIssues`;
    - viewers.
- **States shown:** off / starting / live / reconnecting / ended by YouTube / error.
- **Quota.**
  - A running stream costs 2 units a poll: 288 polls × 2 = 576 a day.
  - The viewers call is one per poll for all channels, 288 a day.
  - Two channels: 2 × 576 + 288 = 1,440 units a day, out of 10,000.
- **History:** interruptions with start, end and cause.
- **Bell notices:**
  - `live_stream_down`: the encoder or YouTube has not been live for more than 5 minutes (a setting);
  - `live_stream_ended`: YouTube ended the broadcast.

### 3.11 Two computers (request §I phase 1) and the Operator (request §J)
- **New sync family `live-streams`** (per-device report v1, ADR 0028 pattern). The Mac publishes per channel:
  - state, since, uptime;
  - the video now playing and its index of N;
  - health, and issue types only;
  - the last interruption (times and a cause code);
  - viewers.

  It never carries a key, a URL, an ingestion address or error text.
- **Windows** shows the same page read-only, about 1–2 minutes behind, with "на <Mac>" in place of the buttons.
  - A new family needs no lockstep update. Windows sees streams once it updates.
- **Factory MCP `factory_live_streams_status`** (read-only, in phase 1): the same fields.
  - The app cannot reach Telegram, so this is how the Operator learns at night that a stream is down.
  - Factory API 1.14.0, additive.

### 3.12 Screens (as a UX designer: audit first, then build)
- **Content gets sub-tabs, «Видео» (today's list) and «Трансляции».** `/content` keeps opening «Видео».
- **«Трансляции»: one card per channel.**
  - State badge, uptime, now playing (N of M), health and viewers.
  - Start / Stop / Restart.
  - Texts and privacy.
  - The rotation: list, order, add, remove, prepare, checks, disk.
  - History.
- **Settings → «Трансляции»** (this computer):
  - the module switch;
  - ffmpeg (detected path and features);
  - storage folder and disk thresholds;
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
- **Planned Mac restart** (`fdesetup authrestart`): the stream comes back.
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
   - the joins between videos and the pass wrap;
   - audio/video drift over a multi-hour run;
   - CPU;
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
4. **Data, sources map, preparing, rotation and the guard.**
5. **Helper supervision, boot restore, recovery** (§3.8 with the spike B results).
6. **Screens, Settings and the bell.**
7. **Sync family and the Windows view; the MCP status and map tools; Factory API 1.14.0.**
8. **Finish:**
   - full suite, lint, build;
   - the §4.2 run with the owner;
   - independent review;
   - the owner's merge decision.

## 6. Spike results
(Filled in while building.)

## 7. Not in phase 1
- **Phase 2:**
  - Stop, Start and rotation edits from Windows;
  - the broadcast thumbnail (`thumbnails.set`);
  - newly published videos added automatically (opt-in);
  - an optional split every ~11 h for archives;
  - the standing approval of §3.8, if needed.
- **Phase 3:**
  - a stream composed live (a looping clip, "now playing" on screen);
  - scheduled one-off streams and premieres;
  - videos whose picture moves.
