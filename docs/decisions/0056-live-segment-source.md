# 0056. A live stream's second source: the owner's selection from the channel's segment library

Status: Accepted for building (owner, Telegram msgs 3792/3793/3795, 2026-10-29; agreed with the Operator). Request: FO-REQ-0048
(BL-234). Amends ADR 0036 (a stream plays the channel's own public videos) with a second, owner-chosen source.

## Context

The 24/7 streams play finished, published videos from `04 Videos/` (ADR 0036). The Operator's generator will render ~30-minute
segments (paintings with their drawing animation, scene loops, random tracks) so the streams no longer depend on published
videos. The Operator proposed a consumed queue on the internal disk that the Manager plays in `seq` order and deletes. The owner
changed it: the segments are a **library** in the channel folder that is never consumed; the owner picks and orders segments in the
stream UI instead of videos, and the stream loops over them like today's rotation.

## Decision

1. **A per-stream source mode**, `live_streams.source_mode` (schema v114): `videos` (null, every stream before; unchanged) or
   `segments`. Only the owner switches it, in the Web UI (session + active channel); no Factory or agent tool reaches it.
2. **The library** is `<channel workspace>/04 Videos/Live Segments/seg-<6 digits>.mp4` + sidecar `seg-<seq>.json` (+ optional
   poster `.jpg`), the same workspace the rotation's originals come from (`channel-workspaces`, read through `resolveWorkspaceFile`).
   A segment is listed only when its `.mp4` and `.json` exist with no `.part` beside either, and the sidecar parses with the same
   `seq` as its file name. The workspace not configured, unreadable (the drive away) or without the folder is a stated reason, never a
   crash. **The app never writes, renames or deletes a library file**; removing a segment removes its selection row only.
3. **The selection** is a table like the rotation (`live_stream_library_segments`, device-local): one row per seq in the owner's
   order, with the facts of its last check (title, probed and sidecar durations, bytes, tracks) so the status works while the drive is
   away. A segment is added only after an ffprobe check (a picture; AAC 44.1/48 kHz, 1-2 channels; a known duration). There is no
   public-only guard and no YouTube duration check: a segment is not a YouTube video.
4. **One engine.** A segment's id in a pass is `seg-<seq>` (10 characters; a YouTube id has 11). The pass, the buffer (copy of the
   playing item and the next ones to the internal disk, `.part` → checks → rename), the encoder helper (concat, re-encode, watchdog,
   resume by index + offset, replay) are unchanged; the buffer checks a segment's copy by ffprobe alone. The supervisor gets the items
   of both sources, so a pass drawn before a switch still finds its files.
5. **The recheck dispatches by mode** (Start, Restart, every encoder start, every next-pass draw). In `segments` mode each selected
   segment is checked again from the library: a missing or unreadable one is left out of the pass and logged (`segment_refused`,
   once per change); with the library unreadable the last checks stand (the buffer's copies keep playing, as a video stream does
   without the drive); none selected or none playable is refused with its reason (`no_segments_selected`, `no_playable_segments`,
   or the library's), never an empty pass at Start. For a running stream the refusal at the next-pass draw is recorded once per
   change (`source_refused`): no segment selected any more (the owner's choice) draws an empty next pass, as an empty rotation does
   (the stream then reports no source); selected segments that cannot play draw nothing, and the helper replays its pass.
6. **When a switch applies:** where rotation edits apply -- at the next pass (the next pass already drawn is dropped so the next draw
   is in the new mode; at the latest the pass after, if the helper reached the end in between), or at once with «Перезапустить
   энкодер» or the next Start.
7. **Status:** `factory_live_get_status` / `agent_live_get_status` gain `sources` (Factory 1.38.0, Agent 4.12.0): the mode, the
   library's availability, the selection's size, playable count and minutes, and in segments mode the segment playing and the
   sidecar track at the playing offset. The shared per-device report is unchanged (`playing` is null for a segment).

## Consequences

- The Operator's generator owns the library's lifetime (writing and, later, pruning); the Manager only reads it. A segment the owner
  selected and the generator later removes is skipped at the next recheck.
- The library lives on the T9 like the originals: losing the drive mid-stream replays the buffer's copies until it returns, and a
  restart while the drive is away keeps the last checks (RISK-141).
- Another computer sees a segments stream as live with `playing: null` until the shared report learns segments.
