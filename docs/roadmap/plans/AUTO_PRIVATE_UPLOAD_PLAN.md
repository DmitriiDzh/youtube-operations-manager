# Automatic private upload of ready release packages (BL-209, FO-REQ-0036)

Sources:
- FO-REQ-0036 (owner via the Operator, Operator Telegram 2166) and DEV-RESP-0039 with its Addendum.
- The owner in the Developer chat:
  - msg 3331: one switch in Settings, next to «Запись в YouTube»;
  - msg 3333: yes to adding the video to the release playlist, and both channels are verified.
- Amends ADR 0037 §1/§3: a standing approval given by the owner's switch.

## Behaviour

1. **Setting.** One device-local boolean `autoPrivateUploadEnabled` covers every channel on this computer.
   - Default off. It persists across restarts.
   - Shown as a labelled toggle on the Live writes Settings card (`src/components/live-writes-settings.tsx`).
   - Changed only by the Web UI route the owner uses. No MCP or agent write path exists (AC-UP-14 stays).
   - UI text keys go into every locale.
2. **Trigger.** A watcher tick (reuse the publishing module's existing timer/watch loop if one exists, else every 5 min) scans
   every connected channel's release packages while the switch is on. A package is queued as an upload **without a date**
   (UPLOAD_PRIVATE only) when all of these hold:
   - it is `ready` by today's checks (manifest, video, thumbnail, chapters, limits, tags);
   - the manifest has the top-level `sha256` (yt-release-package/1), the file's size equals the top-level `sizeBytes`, and
     the file's sha256 equals `sha256`;
   - it has no live upload row on this computer, and no peer reports it as uploading or uploaded (the same checks as the
     owner's approval);
   - the daily insert bucket and the quota pool carry it (else it waits for a later tick, never dropped);
   - its manifest hash has not been auto-queued before (one try per manifest version; a failed auto upload is not retried
     automatically: the owner sees the failure and decides).
3. **Hashing.** The size check runs first (free). The sha256 of the video runs only when the size matches, at most once per
   (manifest hash, file size, mtime). The result is cached. A mismatch is logged once per manifest hash.
4. **Never public, never scheduled.** An auto row always has `publishAt = null`: the upload is private, with no `publishAt`.
   The playlist step runs as for a manual upload (owner msg 3333).
5. **Same runner.** The rows go to the existing upload runner: resumable, resumed after a restart, never twice, identity
   check, `assertLiveWritesAuthorized` before every gateway call (it pauses while Live writes is off).
6. **Log.** Each auto queue writes an event with: when, channel, package (video), manifest hash, the switch state, and the
   resulting upload id. The row is marked `automatic`.
7. **Visibility.**
   - The Content page shows the row like any upload, marked "автоматически".
   - The agent calendar read (`uploads`) gains `automatic`, `progressPercent` (stored bytes / total, null when unknown) and
     `finishedAt`. Factory/agent API minor bump (additive).
8. **Switch off.** Nothing new is queued. Rows already queued stay. The owner can cancel them as today.

## Acceptance (written before the code)

- **AC-AU-01** Switch off (default): a ready package with matching size and sha256 is never queued; no hash is computed.
- **AC-AU-02** Switch on, ready package, size and sha256 match: one upload row is queued, `publishAt` null, `automatic` true;
  one log event with the manifest hash.
- **AC-AU-03** Switch on, manifest without `sha256`: not queued (manual only).
- **AC-AU-04** Switch on, size differs: not queued, no hash computed.
- **AC-AU-05** Switch on, size matches, sha256 differs: not queued; a second tick with the same manifest/file does not hash
  again.
- **AC-AU-06** Switch on, a package not ready (e.g. a title over 100 chars): not queued.
- **AC-AU-07** Two ticks in a row: the package is queued once. A package with a live row, or reported by a peer, is not
  queued.
- **AC-AU-08** A failed auto upload is not re-queued by later ticks for the same manifest hash. A changed manifest (new hash)
  is queued again.
- **AC-AU-09** Daily insert bucket full: not queued this tick; queued on a later tick once there is room.
- **AC-AU-10** An auto row never sends a publish date: the insert resource has `privacyStatus: "private"` and no
  `publishAt`, even when the manifest has a `plannedPublishDate`.
- **AC-AU-11** No MCP tool or agent endpoint can change the switch or reach the auto-queue code (extend AC-UP-14).
- **AC-AU-12** The calendar read reports `automatic`, `progressPercent` and `finishedAt` for an auto row.
