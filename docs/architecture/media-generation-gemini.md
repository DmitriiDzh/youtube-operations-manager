> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 43. Images and video through Google's Gemini API, driven by the Factory Operator (BL-174, ADR 0035)

Plan: `docs/roadmap/plans/GEMINI_MEDIA_PLAN.md` (AC-GM-01..16). Schema v83, Factory API 1.12.0. A separate feature module,
`src/lib/gemini-media/`, beside (not inside) RunPod generation (§26): Google runs the models; the app sends one paid request per result.

- **Boundaries (§M).** The module imports the media gateway, the workspace exchange, channel workspaces and connections, the asset
  catalog, the shared device key file, crypto and money helpers, and `db.ts`'s own helpers; never `media-generation` or
  `generation-plans`, and they never import it (`boundaries.test.ts`). The factory route reaches it only through its barrel.
- **Gateway child** (`media-gateway/gemini-api.ts`, §G). Every request first passes `assertMediaGatewayAuthorized("gemini_api")`
  (the "Media gateway" toggle, one traffic counter). The key is a per-call argument, sent only as `x-goog-api-key` and only to the
  Gemini host; the video download follows redirects by hand and sends no key to another host (https only). Errors carry an
  `outcome`: `answered` (an HTTP answer), `not_sent` (an exact list: DNS, refused, unreachable, named TLS handshake / certificate
  failures, undici's connect timeout, or a failure before the request left: provably never reached Google) or `unknown` (sent, then a timeout or a broken body: Google
  may have finished and charged). `http.ts`'s `unavailable` now receives the caught error for this, and takes a `redirect` option:
  the Gemini child passes `"error"`, because fetch keeps custom headers (the key) across a redirect to another host.
  Images: Interactions API (`POST /v1beta/interactions`, `response_format { type: "image", aspect_ratio, image_size }`,
  `store: false`), the final images read from `steps[]` (`model_output` blocks; thought steps skipped), falling back to the legacy
  `outputs[]`. Video: `models/{model}:predictLongRunning` (`instances[0]` prompt and `inlineData` frames / `referenceType: "asset"`
  references), the operation polled by name (validated `models/…/operations/…`), the sample's URI downloaded through a `.part` file.
- **Key.** `device-key-file` holds the key-file logic moved unchanged out of `media-generation` (which keeps its own file and error);
  the module's file is `gemini-media.key`. A key is checked (`models.list`; 400/401/403 = invalid, 402 = valid with an empty balance)
  before it is stored; only the last 4 characters leave the module.
- **Create** (`createJob`). Strict schema, then the per-model rules (`checkJobRules`), all before any read or write. A `requestId`
  already used returns that job when the request hash matches (before every other check, so a retry never creates a second paid job),
  else `gemini_request_exists`. Then: the switch, the key, the channel connected here, its workspace, every input resolved in
  `Sent to YTM` (contained, regular file, ≤ 7 MB, ≤ 12 MB together) and read through one descriptor whose dev/ino must match
  (`adapters/files.ts`), the estimate, and the limits in order per job / day / month / active jobs. A dry-run answers the same verdict and
  stores nothing. The whole create runs under one promise-chain lock kept on `globalThis` with the core (the MCP route, the Web routes
  and `instrumentation.ts` are separate bundles), so two creates never both pass a limit.
- **Money.** `pricing.ts`: estimates and costs from the price table (`GEMINI_PRICES_AS_OF`) through `shared-money.ceil4` (4 decimals,
  up). An image's cost is Google's token counts (all input at the input rate, image output at the image rate, other output and thinking
  at the text rate), else the table's per-image price; a video's cost is its table price. Spend = finished costs + active estimates,
  local calendar day / month, from `gemini_media_jobs` (device-local).
- **Worker** (`worker.ts`, its own 5 s loop in `instrumentation.ts`, behind the device mutation gate; ≤ 3 jobs in flight). Every status
  change is a compare-and-set from the status read. A queued job is claimed (`submitting`), its key decrypted, its inputs re-read and
  re-hashed (a changed file fails it unsent), its output folder resolved -- all before Google is called. Retry (back to `queued`,
  30 s / 2 min, 3 attempts, then failed at 0): 429, 408, 5xx, a connection that never reached Google. Not retried: a refusal (400 →
  `gemini_invalid_request`, a blocked code → `gemini_blocked`, 401/403, 402; cost 0) and an `unknown` outcome (`gemini_timeout` or
  `gemini_unavailable` at the estimate, basis `unknown_outcome`). An image answer with no final image is `gemini_blocked` at Google's own
  counts (0 without them) only for a terminal refusal or a `completed` answer with readable counts; anything else (an unreadable body,
  a non-terminal status) counts its estimate. Counts are read only from the documented fields (integers or decimal strings). A finished image costs
  Google's counts, never below the table price of the images saved. A job still `submitting` 15 minutes after its claim and not in
  flight here (a write failed after the call) is failed at its estimate by the next tick. Files are written through the shared crash-safe write, registered as assets (a catalog failure is a note), the manifest last;
  only then `done`. A video moves `submitting` → `running` with its operation name and is polled every 10 s; any poll or download
  failure retries in 30 s until 47 h after the start (`gemini_expired` at the estimate); a finished operation with an error or no sample
  costs 0. At startup a job left `submitting` fails `gemini_interrupted` at its estimate; `running` videos resume. With the switch off,
  queued jobs fail `gemini_disabled` unsent; running videos are still collected.
- **Omni (BL-179, FO-REQ-0021, `docs/roadmap/plans/GEMINI_OMNI_PLAN.md`; Factory API 1.15.0).** Google shuts the Veo 3.1 previews
  down on 2026-10-22, and `predictLongRunning` rejects first/last frames (HTTP 400; Google: frames only through generateContent).
  - `gemini-omni-1.1-flash` (`transport: "interactions"`) is one synchronous `POST /v1beta/interactions` call (15-min timeout,
    `store:false`, `delivery:"inline"`). The frames come first, in order, with `video_config.task = "image_to_video"`.
  - The call goes through `http.ts`'s `createLongWaitFetch` (`node:http(s)`): fetch itself gives up after 300 s without response
    headers whatever the signal (undici, probed). The transport never follows a redirect, caps the body (the video limit in
    base64 + 1 MB) and keeps transport codes. undici's own waits count as timeouts (outcome `unknown`).
  - The worker runs it like an image job. Its cost is Google's token counts (`videoCostFromUsage`: input at the input rate, text
    output and thinking at the text rate, all other output, audio included, at the video rate), never below the saved video's
    table price (`videoCostFloor`), else the estimate. The estimate is 5,792 video tokens per second at 720p, 2.25 x for
    1080p, plus input and the thinking allowance (1080p: 8,688 a second since Omni 1.2, below).
  - A video delivered as a Files API URI (normalised to its download link) becomes `running` with the URI as `remoteName` and its
    known cost. The poll downloads it without a Veo operation; a 404 or the 47-h give-up keeps the known cost. A link that
    cannot be followed fails the job at its cost, and a JSON answer to a download is refused. The stale-`submitting` sweep is 20
    min, above the 15-min call.
  - The model table gains `frames` and `retiresOn` (and had `transport` until BL-180). Frames on a Veo model were refused at
    create time (`gemini_invalid_params`), before any call.
  - A transport error names its inner cause (FO-MSG-0014).
  - The request details the paid test still has to confirm are listed in RISK-127.
- **Veo removed (BL-180, owner msg 2902, 2026-10-17; Factory API 1.21.0).** The three Veo 3.1 previews left the model table ahead
  of Google's 2026-10-22 shutdown, with their transport: the gateway's `startVideo` (`predictLongRunning`) and
  `getVideoOperation`, and the worker's operation start and poll. Omni is the only video model. A Veo id is refused at create
  time (`gemini_invalid_params`, field `model`). A Veo job left `queued` is failed unsent (`gemini_invalid_request`, cost 0); one
  left `running` holds an operation name, not a link, so it is not polled and fails `gemini_expired` at its estimate. The
  operation-flow paragraph above is history.
- **Omni 1.2 (owner TG 3700, 2026-11-23; Factory API 1.55.0, Agent API 4.26.0).** Google made `gemini-omni-1.2-flash` GA on
  2026-11-05 and routes `gemini-omni-1.1-flash` to it from 2026-12-03 (aistudio.google.com/docs/deprecations). The model table's
  one video entry is now 1.2 at the pricing page's figures: $1.50 input, $9 text and thinking, $12 video per 1M tokens; 5,792
  video tokens per second at 720p and 8,688 at 1080p (the page's own count, replacing the 2.25 x guess). The request is unchanged
  (the docs show the same `/v1beta/interactions` body; `response_format.duration` is `"<n>s"`).
  - Each video model carries `durationSeconds { min, max, maxWithLastFrame }`: 3-15 whole seconds, at most 10 with a last frame
    (Google's interpolation limit), checked in `checkJobRules` before any call (`gemini_invalid_params`).
  - `GEMINI_VIDEO_MODEL_ALIASES` maps the deprecated 1.1 id to 1.2; `resolveGeminiVideoModel` / `geminiVideoModelSpec` are the one
    lookup for create (the job is checked, estimated, stored and sent as 1.2), the worker (a 1.1 job left queued is sent as 1.2),
    and pricing. The replay check accepts the request hash of the given or the resolved content, so a job stored as 1.1 is still
    returned to a retry naming 1.1. The catalog lists only 1.2, with `durationSeconds` and `aliases`.
- **Restarts.** `operation-lock media-idle` refuses `stop.sh` while a job is `submitting` (an image call takes up to 5 minutes, an Omni video up to 15); idle
  shutdown waits while any job is queued, submitting or running.
- **Web.** Settings → Cloud APIs (`gemini-media-settings.tsx`; Settings → Gemini before BL-193) and `/api/gemini-media` (overview), `/settings`, `/key`, `/key/test`: the
  owner's side only; no MCP tool sets the key, the switch or the limits. BL-193: the recent jobs moved to the Gemini card in
  Servers → Sessions (§50).
- **Limits.** The money limits were per computer until BL-193; since then they are shared by every computer on the key (§50, RISK-123); prices are code constants; the Veo previews were removed by BL-180. Not in this slice:
  Gemini Omni Flash, the Batch API, Veo extension, multi-turn editing, generation-plan attempts from Gemini jobs.
