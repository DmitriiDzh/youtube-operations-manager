# Media review tools in the app (listening verdict for generation plans)

Owner request (Telegram 2026-10-07, msg 1931): all three phases of generation plans (FO-REQ-0006 / DEV-RESP-0008) are approved.
Because the listening verdict moves into the app (owner decision Q1: in the app **and** relayed in chat), the owner needs real
tools for it: a built-in player, the waveform, and similar. The Factory Operator is building validators on its side. This document
is research and a proposal only; nothing is implemented yet.

## 1. Facts this builds on (checked 2026-10-07)

- **No playback exists in the app today.** There is no `<audio>`, no Web Audio and no route that serves a local media file.
- **Generated outputs are local files** in the channel workspace. A real example: `<workspace>/99 Data Exchange/From YTM/media/<jobId>/r0001_ace15_xl_sft_00001.mp3`,
  MP3, about 5 MB per track. Each job output records `localPath`, `bytes` and `sha256`, and is cataloged as an asset.
- **Post-processing and validators run outside the app**, on the Factory Operator's side. The file the owner should judge is
  often the post-processed one, not the raw job output. The app has to be told which file to play.
- **Plans are edited only on their owning device** (DEV-RESP-0008 §3). Other devices see a read-only report.
- **The workspace folder exists only on devices where the owner configured it.** Whether a file is present on a second device
  depends on the owner's own folder sync. The app cannot assume it.

## 2. What the review screen should offer

Grouped by value. **A** is phase 1, needed for a verdict to be meaningful. **B** follows soon after. **C** is optional.

| | Tool | Why it matters for a listening verdict |
|---|---|---|
| A | **Player**: play/pause, seek, current time and duration, volume | The minimum |
| A | **Waveform** with a playhead; click to seek; overview of the whole track | See silences, abrupt ends, clipping and dynamics at a glance; jump to suspicious places |
| A | **Review queue**: the items waiting for `owner_review`, next/previous, auto-advance after a verdict | 24–64 tracks per wave; the verdict must be fast |
| A | **Keyboard**: Space play/pause, ←/→ seek ±5 s, A accept, R reject, N/P next/previous | A wave reviewed without the mouse |
| A | **Verdict with a reason**: Accept / Reject, plus optional reason chips (artifacts, wrong genre, boring, too loud, bad ending, …) and a note | The Factory Operator learns from the reasons (sent with the verdict, visible in `factory_plan_get`) |
| A | **Validator results next to the player**: each check with value, threshold and pass/fail, highlighted when failed | The owner judges with the machine's findings in view, and can overrule them |
| A | **Generation details**: template, prompt or parameters, seed, GPU, job time | Context for the verdict and for asking the factory for a re-run |
| B | **Loudness-matched playback**: play every track at the same perceived loudness (for example −14 LUFS), using the validator's measured LUFS, or measured in the browser if absent | Louder tracks sound "better"; matching removes that bias |
| B | **Markers on the waveform**: validator findings placed at their time (a clip at 1:42, silence from 3:10) | Jump straight to the problem |
| B | **Loop a region** (drag on the waveform) | Re-listen to a transition or an artifact |
| B | **A/B compare** with a reference track, or between two candidates, loudness-matched, switching at the same position | Judge against a target sound, not from memory |
| C | **Spectrogram** (toggle) | Shows hiss, band-limited "AI" artifacts and frequency gaps the waveform hides |
| C | **Rating 1–5** in addition to accept/reject | Ranking within the accepted ones (e.g. which tracks open a video) |
| C | **Images and video** in the same panel (zoom, frame step) | The same review flow for thumbnails and loops later |

## 3. How it would work technically

- **Serving a file to the browser**: one new read-only route.
  - It serves a plan item's audition file by **plan id + item + attempt**, never by an arbitrary path.
  - The file must be inside a configured channel workspace. This reuses the existing containment checks (`workspace-exchange` / `local-path-validation`), including symlinks.
  - Only an allowlist of audio, image and video types is served. HTTP Range requests are supported, so seeking works without loading the whole file.
  - The route is loopback only, like the rest of the app.
  - If the file is missing on this device, the screen says so instead of failing.
- **Waveform and spectrogram**: drawn in the browser from the decoded audio (Web Audio `decodeAudioData`). The server needs
  no audio decoder, so there is no ffmpeg dependency. Two ways to build it:
  1. **`wavesurfer.js` v7** (BSD-3, maintained). Waveform, regions/loop, timeline, hover, minimap and spectrogram plugins
     are ready. It is one new front-end dependency, needs no server part, and loads only on the review screen. **Recommended.**
  2. **Own canvas component**: no dependency, but we would write and maintain region looping, zoom and the spectrogram FFT
     ourselves. That is several times the effort for the same result.
- **Loudness match**: a gain per track from its LUFS, applied with a Web Audio `GainNode`, never by changing the file.
  When the validator did not report LUFS, it is measured once in the browser (ITU-R BS.1770 K-weighting on the decoded
  samples) and cached with the item.
- **Module boundaries (AGENTS.md §M)**:
  - **`media-review`**: a separate UI module (player, waveform, queue, verdict form). It knows nothing about plans except "an item to review" and "send a verdict". It can therefore be reused later for asset review outside plans.
  - **`workspace-media`**: file serving as its own small read module.
  - Plans depend on both; neither depends on plans.

## 4. What the Factory Operator's side has to provide (extends `factory_plan_report`)

To make §2 possible, a report for a stage can carry:

- **`auditionFile`**: the file the owner should judge. It is a path relative to the channel workspace, typically the
  post-processed file in `99 Data Exchange/Sent to YTM/…`, the same convention as job inputs. If it is absent, the job's own
  output is played.
- **`checks[]`**: the validator's results in a fixed shape, for example `{ id: "lufs_integrated", label, value, unit, threshold,
  pass: true|false, severity: "info"|"warn"|"fail", atSeconds?: [start, end] }`. `atSeconds` puts a marker on the waveform.
- **`metrics`** (optional, free key/value) for values that are not checks: BPM, key, duration, true peak, and so on.

Sizes are bounded (for example 50 checks, 2 KB per note), and no file contents travel in a report. **We need the Factory Operator's
validator output format** to fix this shape. It is asked in DEV-MSG-0002.

## 5. Other devices

Phase 2 shows plans on other devices read-only. Reviewing there needs two things:

- the file present on that device (the owner's folder sync);
- the verdict reaching the owning device.

Proposal for phase 2: each device publishes its own verdicts in its plan report, and the owning device takes them in. This is the
same one-writer-per-file rule as job results from other devices, so nothing is merged. Until then the review screen on a
non-owning device is view-only: it plays the file if present, but the verdict buttons explain where to give the verdict.

## 6. Where it fits in the three phases

- **Phase 1** (plans on the owning device): review screen with group A. Also the file route, `auditionFile` / `checks` in
  `factory_plan_report`, and `wavesurfer.js` (waveform + regions plugins only).
- **Phase 2** (other devices): verdicts from any device (§5); review screen on other devices when the file is present.
- **Phase 3** (notices, budget, agent read tools): group B (loudness match, waveform markers, loop, A/B). Group C if the owner
  wants it.

## 7. Owner decisions (Telegram 2026-10-07, msg 1933)

1. `wavesurfer.js`: yes.
2. Reason chips: the starting list in §2 for now.
3. Loudness match: stays in phase 3 as proposed.
4. Spectrogram (group C): yes, in phase 3.
5. msg 1939 (accepting the Factory Operator's FO-MSG-0008 additions): **moved into phase 1**:
   - a rating **out of 10** (not 1–5);
   - a comment on every track;
   - "mark at playhead";
   - blind mode as a toggle, off by default;
   - "ask for a re-run";
   - the validator's `atSeconds` markers on the waveform;
   - the reason list from R-0001: thin / sparse; dropout / pause; abrupt start; dead tail / abrupt end; ringing / whine; wrong
     instrument; stuck loop; sounds like the others; not melodic / boring; unwanted beat / drums; plus free text.

   A/B against a library track stays in phase 3 with loudness match. Plan: `GENERATION_PLANS_PLAN.md`.

## 7a. The questions as asked

1. **New dependency `wavesurfer.js`** (front end only): OK? The alternative is our own canvas component, which costs much more.
2. **Reason chips**: use the starting list in §2, or do you have your own words for why a track is rejected?
3. **Loudness match** in phase 3: is that early enough? It could move into phase 1, costing about half a slice more.
4. **Spectrogram and rating (group C)**: wanted?
