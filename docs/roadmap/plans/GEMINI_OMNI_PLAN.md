# Gemini video: Omni replaces Veo 3.1 preview (FO-REQ-0021, FO-MSG-0014, BL-179)

- **Status:** BUILT 2026-10-13 on `feature/bl-179-gemini-omni` (items 1-3 of §2). Item 4 (the "Google did not charge" action) waits
  for the owner's answer (Telegram msg 2679, question 3). The paid acceptance test (§3) needs the owner's explicit "да" (question 1).
  Veo is handled per the recommended option (a), frames refused before any call (question 2, not yet answered; option (b) would
  re-test one other frame shape).
- **Request:** FO-REQ-0021 (high priority; Google shuts the Veo 3.1 previews on 2026-10-22) and FO-MSG-0014. Both were created by the Operator on 2026-10-12.
- **Sources:** Google's docs, read 2026-10-13:
  - https://ai.google.dev/gemini-api/docs/omni
  - https://ai.google.dev/gemini-api/docs/pricing
  - https://ai.google.dev/gemini-api/docs/deprecations
  - https://ai.google.dev/gemini-api/docs/veo
  - https://ai.google.dev/api/interactions-api
  - https://ai.google.dev/gemini-api/docs/api-errors

## 1. Findings

- **Veo 3.1 previews retire.**
  - `veo-3.1-generate-preview`, `-fast-` and `-lite-` shut down on 2026-10-22. The replacement is `gemini-omni-1.1-flash`.
  - No GA Veo 3.1 id exists for the Gemini API.
- **Veo frames.**
  - The Veo page says first/last frames are "currently only available with the generateContent API".
  - Our `predictLongRunning` call got HTTP 400 `inlineData isn't supported by this model` (job `gm_7d1d80b2`, not charged).
- **Omni** works through `POST /v1beta/interactions`, the same transport as the image models.
  - Images go in `input[]` as `{type:"image", mime_type, data}`, plus a text block.
  - With `generation_config.video_config.task = "image_to_video"`, the first image is the start frame and an optional second image is the end frame.
  - The output format is `response_format: {type:"video", aspect_ratio: 16:9|9:16, resolution: 720p|1080p(upscaled)|4k(upscaled)|360p, delivery: inline|uri}`.
  - `duration` is a string in the reference, with no documented values.
  - Audio is always generated.
  - The documented call is synchronous: the result's `steps[].content[]` holds `{type:"video", mime_type:"video/mp4", data}`.
  - Background mode is not documented for Omni. `store:false` cannot be combined with background.
  - There is no list endpoint and no idempotency key.
- **Omni price:**
  - input: $1.50 per 1M tokens;
  - video output: $17.50 per 1M tokens;
  - about 5,792 tokens per second at 720p, so about $0.10 per second;
  - the 1080p and 4k token counts are not stated.
- **FO-MSG-0014 (`gm_8ddb1c7b`):**
  - `remote_name` is empty: the answer that was lost belonged to the `predictLongRunning` submit itself.
  - The failure came 42 s after the submit.
  - The service log has no cause beyond "fetch failed".
  - An identical request 4 min later got the deterministic 400.
  - Veo charges only for generated videos, so the lost request was almost certainly not charged.

## 2. Proposed design

1. **Omni video model.** `GEMINI_VIDEO_MODELS["gemini-omni-1.1-flash"]`, transport `interactions`.
   - It covers text-to-video, a first frame, and first + last frame. A reference image is not offered.
   - Resolutions are 720p and 1080p, at 16:9 and 9:16. Durations are 4, 6 and 8 s as `duration: "<n>s"`; the paid test checks the format.
   - The call is synchronous with a 15-minute timeout, `store:false`, and `delivery:"inline"`. It goes through a `node:https` transport, because fetch gives up after 300 s without response headers (review).
   - The cost comes from Google's `usage`: input at the input rate, video tokens at the video rate. Without usage, it falls back to the table.
   - The estimate for 720p is 5,792 tokens per second. 1080p is estimated at 2.25 x 720p (the pixel ratio) until the test measures it.
2. **Veo.** Frames on a Veo model are refused before any call (`gemini_invalid_params`, field `video.inputs.firstFrame`, free), and the error names Omni.
   - `factory_gemini_get_status` marks each Veo model with `retiresOn: "2026-10-22"` and `frames: false`.
   - After 2026-10-22 the models are removed from the catalog (BL-180, a follow-up).
3. **A lost answer** keeps its current behaviour: the job fails, the estimate is counted, and there is no automatic retry (it could bill twice).
   - The job's `error` gains the transport cause code, for example `UND_ERR_SOCKET`.
4. **The owner's "Google did not charge"** action for an `unknown_outcome` job, in Settings → Gemini → recent jobs.
   - The cost becomes 0 with `costBasis: owner_released`, and an audit row records it.
   - The month's spend recounts.

## 3. Acceptance

- The owner-approved test: Omni, 8 s, 720p, with first frame = last frame = `pick_still01.jpg`.
  - It completes, costs about $0.80, and lands in `From YTM/gemini/<jobId>/` with a manifest.
- Veo with frames → `gemini_invalid_params` before any call. The status lists the retirement date.
- A 400 keeps Google's message in the job's `error`.

## 4. Built (2026-10-13)

- **Gateway** (`media-gateway/gemini-api.ts`):
  - `generateVideo` makes one `POST /v1beta/interactions` call. Frames come first in order, then the text. With frames it sets `generation_config.video_config.task = "image_to_video"`.
  - `response_format` is `{type:"video", aspect_ratio, resolution, duration:"<n>s", delivery:"inline"}`, with `store:false` and a 15-min timeout.
  - The video is read from the `steps[]` model output (inline `data` or `uri`); `usage` and block codes are read as for images.
  - A transport error now names the inner cause, for example `UND_ERR_SOCKET: other side closed` (FO-MSG-0014 Q3).
- **Module** (`gemini-media`):
  - The video model table gains `transport`, `frames`, `retiresOn` and Omni's `tokenPricing`.
  - The estimate counts video tokens per second, input tokens (prompt, frames) and the thinking allowance.
  - The cost comes from Google's counts (`videoCostFromUsage`), otherwise from the estimate.
  - The worker runs an Omni job like an image job: claim, one call, then the file, the asset and the manifest. A URI delivery becomes `running` with the URI as `remoteName`, and the poll downloads it without a Veo operation.
  - Veo frames are refused at create time.
  - Factory API 1.15.0.
- **Assumptions the paid test checks:**
  - `duration` as `"8s"`;
  - an inline answer;
  - the 1080p token count (estimated at 2.25 x 720p).

  A wrong `duration` format is a free 400 that keeps Google's message. See RISK-127.

## 5. Independent review (2026-10-13), fixed

- **Blocker.** fetch's own 300 s headers timeout cut the 15-min call. The Omni call now goes through `createLongWaitFetch`
  (`node:http(s)`): no follow of a redirect, a body cap, transport codes kept. `UND_ERR_HEADERS_TIMEOUT`/`UND_ERR_BODY_TIMEOUT` count
  as timeouts everywhere.
- **Cost floor.** A saved video costs at least its table price (`videoCostFloor`). Audio and other non-text output are priced at
  the video rate, and the output total is at least its modality split.
- **Stale sweep.** It moved to 20 min, above the 15-min call.
- **URI path.**
  - A Files API reference is normalised to its download link.
  - A non-http(s) link fails the job at its cost, with no polling.
  - A 404 on the download, and the 47-h give-up, keep the known cost.
  - A JSON answer to a download is never saved as the video.
- **Spend.** An active job whose cost is known counts that cost instead of its estimate.
