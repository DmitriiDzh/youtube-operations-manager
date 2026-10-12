# 0036. A channel's 24/7 live stream of its own public videos, sent from the Mac; YouTube is written only by the owner

Status: Accepted

**Date:** 2026-10-12. **Decided** by the owner (Telegram): assignment msg 2572 (2026-10-11, «возьми в работу REQ-0019»); go and
answers msg 2575 (2026-10-12); the buffer details proposed in msg 2577 and accepted in msg 2578 («ок»). Request FO-REQ-0019. Plan:
`docs/roadmap/plans/LIVE_STREAMS_PLAN.md` (BL-176).

## Context

The Operator asked for each channel to run a 24/7 live stream that loops the channel's own published videos. PROJECT_SPEC §58 lists
"livestream management" as a non-goal, and the app has no live code. Live writes are off at every boot and switch off after 10 idle
minutes (ADR 0032 §4, RISK-09), so a stream cannot depend on a YouTube write that nobody is present to approve. The Mac's internal
disk has 30 GB free; the originals (47 GB for both channels) sit on the T9, which mounts only at login after a restart and has
disconnected by itself.

## Decision

1. **Scope.** §58 is lifted for one case only: a loop of a channel's own **public** videos, sent from the Mac running as the system
   service (ADR 0032). Not in scope: live generation, chat, hosted streaming services, streaming from Windows.
2. **A separate module, `src/lib/live-streams/`** (AGENTS.md §M), off by default in Settings. Off, it runs no timer and no process,
   and every other screen works as before. ffmpeg is found, checked and spawned only by the shared `src/lib/ffmpeg-host/`.
3. **YouTube is written only through the write gateway and only by the owner.** New gateway primitives (`insertLiveStream`,
   `insertLiveBroadcast`, `bindLiveBroadcast`, `transitionLiveBroadcast`, `updateLiveBroadcast`) are in `WRITE_PRIMITIVE_NAMES`, and
   each caller checks `assertLiveWritesAuthorized` first. Creating, binding, starting, ending or editing a broadcast happens only on
   the owner's button press, with Live writes on, after a dry-run dialog and an identity check. Reads go through the read gateway.
4. **The owner's "on" is a saved intent; keeping the encoder running is not a YouTube write.** The app restarts its local encoder
   after a crash, a network drop, a server restart or a Mac restart. If YouTube has ended the broadcast, the app stops the encoder
   and tells the owner; it never starts a new broadcast by itself.
5. **A running stream does not keep Live writes on.** It is not "busy" for the idle watcher, so Live writes still switch off after
   10 idle minutes. ADR 0029 §4 is unchanged.
6. **Public-only guard.** A video enters and stays in a rotation only if YouTube, read fresh, says it is public with no future
   `publishAt`. An override needs the owner's reason and is audited.
7. **Storage: a rolling buffer of originals on the internal disk** (the owner's proposal). The buffer holds the video now playing
   and the next ones (depth 2 by default, a setting). Each copy is written under a temporary name and renamed only after its checks.
   A copy is deleted only after the encoder has moved past it. When the next copy cannot be made (T9 missing, file gone, disk too
   full), the stream replays the buffer and the bell says so; it does not stop.
8. **The stream key is never stored** and never leaves the helper and ffmpeg. It is read from YouTube at each encoder start, and a
   scrubber removes it from every log, event, status file, report and MCP output. If YouTube does not return the key on read
   (spike B), it is stored encrypted with the device key file, like the Gemini key.
9. **Other computers see streams read-only** through a new per-device sync family `live-streams` (ADR 0028 pattern), and the
   Operator through the read-only Factory MCP tool `factory_live_get_status` (Factory API 1.14.0; it maps files with the local write
   `factory_live_map_sources`). Neither carries a key, a URL or error text.

## Consequences

- The T9 becomes a running dependency: a new video is copied from it about every 2 h. After an unattended restart, the buffer is
  the stream's runway until someone logs in.
- The picture is re-encoded live: about 24 % of one core per stream on the M4 (measured, 60 s).
- The key appears in ffmpeg's command line, which the other account on the Mac can read with `ps`. That account already holds the
  channels' Google sign-in (ADR 0032), so it gains no new capability; the risk is recorded in TECHNICAL_DEBT.
- Whether YouTube keeps a broadcast live across a 2-, 10- or 30-minute gap with auto-stop off is not documented. Spike B measures
  it on an unlisted Tropico broadcast, which needs the owner's separate "да" (AGENTS.md §K.4). If YouTube ends broadcasts across
  short gaps, an automatic restart would need its own scoped standing approval and its own ADR.
- Quota: each live method costs 1 unit; two running streams cost about 1,440 units a day in status polls.

## Alternatives rejected

- **All originals on the internal disk:** 47 GB does not fit in 30 GB free.
- **"Stream-ready" re-encoded copies (request §C):** 92–200 GB.
- **All prepared sources (audio plus one frame a second, ≈ 14 GB):** fits, but needs a preparing step and refuses videos whose
  picture moves; the owner preferred rotating files.
- **Reading straight from the T9:** the stream would fail after an unattended restart and whenever the T9 disconnects.
- **Starting a new broadcast automatically when YouTube ends one:** an unattended YouTube write, which RISK-09 rules out.
