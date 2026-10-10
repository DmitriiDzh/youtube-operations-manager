# Images and video through Google's Gemini API, driven by the Factory Operator (BL-174)

**Status: BUILT on `feature/gemini-media`; validation passed; review rounds next, then the owner's merge decision.** Owner, Telegram 2026-10-10:
- msg 2523: asked to research Nano Banana: image generation by API without renting servers, video, prices. Answered in msg 2524.
- msg 2525, verbatim: «Проведи исследования как можно интегрировать в нашу систему и выдать контроль оператору через mcp. Составь
  план и приступай к реализации. Как всегда по нашим правилам сделай эту интеграцию отдельным модулем.»

No real paid Google call is made while building this. Every test uses an injected fake `fetch`. The first live call happens only
after the owner enters a key, turns the module on, and says so (§7).

## 1. Facts (Google docs read 2026-10-10; code read on `dev` 740e8e8)

### 1.1 The API

All paid tier; the API has **no free tier for image or video models**.

- **Host and auth:** `https://generativelanguage.googleapis.com/v1beta/…`, header `x-goog-api-key`.
- **Key check:** `GET /v1beta/models` (cheap).
- **Errors** (Interactions API errors page): 400 `invalid_request`, 401 `authentication`, 402 `payment_required` (prepaid balance
  empty, do not retry), 403 `permission_denied`, 404, 429 (`rate_limit_exceeded` | `quota_exceeded` | `too_many_requests`), 5xx.
  - Retry only 429, 408 and 5xx, with backoff.
  - Google charges nothing for a request that fails with 400 or 500.

**Images (Nano Banana) — Interactions API**, the only documented form for these models:

```
POST /v1beta/interactions
{ model, input, response_format: { type: "image", aspect_ratio, image_size }, store: false }
```

- `input` is a string, or parts: `[{type:"text",text}, {type:"image",mime_type,data(base64)}…]`.
- The answer carries `steps[]`. In the `model_output` step, `content[]` holds `{type:"image", mime_type, data}`. Thought steps may hold
  interim images; those are not charged and are skipped.
- `usage`: `total_input_tokens`, `total_output_tokens`, `total_thought_tokens`, `output_tokens_by_modality[{modality,tokens}]`.
- `store:false` means Google keeps nothing for later retrieval. Background mode needs `store:true` and is documented only for text
  models, so image calls are synchronous: about 10–60 s.
- `image_size` must be uppercase: `1K` | `2K` | `4K`.

| Model | Sizes | Input $/1M | Text and thinking out $/1M | Image out $/1M | Tokens per image |
|---|---|---|---|---|---|
| `gemini-nano-banana-2.1` | 1K, 2K, 4K | 1.50 | 7.50 | 30.00 | 1K 1120 ($0.0336), 2K 1680 ($0.0504), 4K 3780 ($0.1134) |
| `gemini-3.1-flash-lite-image` | 1K only | 0.25 | 1.50 | 30.00 | 1K 1120 ($0.0336) |
| `gemini-3-pro-image` | 1K, 2K, 4K | 2.00 | 12.00 | 120.00 | 1K–2K 1120 ($0.134), 4K 2000 ($0.24) |

- Aspect ratios: 1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9.
- Reference images: up to 14 (Lite), 10 objects + 4 characters (2.1), 6 objects (Pro).
- Every image carries an invisible SynthID watermark.
- Not used:
  - `gemini-2.5-flash-image`: shut down 2026-10-02.
  - `gemini-3.1-flash-image`: superseded by 2.1.

**Video (Veo 3.1)**, generateContent family:

```
POST /v1beta/models/{model}:predictLongRunning
{ instances:[{ prompt, image?, lastFrame?, referenceImages? }], parameters:{ aspectRatio, resolution, durationSeconds, personGeneration? } }
```

- Images are passed as `{inlineData:{mimeType,data}}`. The call returns `{name}`.
- Poll `GET /v1beta/{name}` until `done`. The result is at `response.generateVideoResponse.generatedSamples[0].video.uri`.
- Download that URI with the key, following redirects.
- 11 s to 6 min. The video is kept by Google for 2 days. One video per request, 24 fps, audio always on, SynthID.
- A blocked video is not charged.

| Model | 720p $/s | 1080p $/s | 4K $/s |
|---|---|---|---|
| `veo-3.1-generate-preview` | 0.40 | 0.40 | 0.60 |
| `veo-3.1-fast-generate-preview` | 0.10 | 0.12 | 0.30 |
| `veo-3.1-lite-generate-preview` | 0.05 | 0.08 | not supported |

Veo parameter rules:
- Duration: "4" | "6" | "8". 1080p and 4K require 8.
- Reference images: up to 3, Veo 3.1 and Fast only, duration 8.
- `lastFrame` only together with `image`.
- Aspect ratio: 16:9 | 9:16.
- `personGeneration`: `allow_all` for text-to-video, `allow_adult` for image modes. EU/UK/CH/MENA allow only `allow_adult`, so the
  default is to omit it.

**Not in this slice:**
- Gemini Omni Flash: its 1080p/4K prices and its duration parameter are undocumented, so no limit could be enforced before the call.
- Batch (half price, up to 24 h).
- Veo extension.
- Multi-turn editing.

**Account limits outside the app** (worth the owner setting in AI Studio):
- A project monthly spend cap (Spend → Monthly spend cap). It is experimental and overshoots by about 10 minutes.
- Prepaid credit, minimum $5. At $0 every key gets 402.
- Countries: Russia and Belarus are not on the API's list.

### 1.2 The codebase

- **Outbound media calls:** they go through `src/lib/media-gateway/` (barrel, one child per external API product, the "Media gateway"
  toggle checked inside each request, one traffic counter per child). `inventory.test.ts` fails on a gateway host string anywhere
  else. The shared transport is `http.ts` (`jsonRequest`).
- **Files and assets:**
  - `src/lib/workspace-exchange/`: `resolveFromYtmDir`, `resolveSentToYtmFile` (containment, symlink and identity proofs),
    `resolveFromYtmJobFile`.
  - `src/lib/asset-catalog/`: `registerAsset` with free-form provenance.
- **RunPod/S3 keys:** one AES-256-GCM blob under a per-device key file `media-generation.key`, created by the app (ADR 0023).
  `media-generation/key-file.ts` holds that logic inside the media module.
- **Factory MCP:** a closed tool list (`FACTORY_TOOL_NAMES`, `FACTORY_WRITE_TOOL_NAMES`) and strict zod schemas. A write calls
  `assertMutationAllowed()` first; a dry-run is a read. Version 1.11.0. Read tools must match the name pattern in
  `factory-server.test.ts`.
- **Restart safety:** `operation-lock media-idle` makes `stop.sh` refuse a stop while a media session is active. `instrumentation.ts`
  `isBusy` blocks idle shutdown.

## 2. Design

### 2.1 Modules (AGENTS.md §G single gateway, §M independence)

- **`src/lib/media-gateway/gemini-api.ts` (new gateway child).** It is the only code that reaches `generativelanguage.googleapis.com`.
  - Same shape as `huggingface.ts`: `createGeminiApiClient({ fetchImpl?, authorize?, baseUrl? })`.
  - Every request first calls `authorize("gemini_api")`: the "Media gateway" toggle plus a new traffic category `gemini_api`.
  - Methods:
    - `listModels(apiKey)`: the key check;
    - `generateImage(apiKey, request)`;
    - `startVideo(apiKey, model, request)`: returns the operation name;
    - `getVideoOperation(apiKey, name)`;
    - `downloadVideo(apiKey, uri, destPath)`: streams to `.part`, then renames; returns bytes and sha256.
  - It maps HTTP status to `gemini_*` codes (§2.6). The key travels only to `generativelanguage.googleapis.com`. A redirect to another
    host is followed **without** the key, and only over https.
  - `HOST_PATTERN` gains `generativelanguage\.googleapis\.com`.
- **`src/lib/gemini-media/` (new feature module)**, laid out as contracts / schemas / services / adapters / index.
  - It owns the jobs, limits, key storage, worker, files and manifest.
  - It depends on `media-gateway`, `workspace-exchange`, `channel-workspaces`, `local-path-validation`, `asset-catalog`,
    `shared-crypto`, `shared-money`, `atomic-json-file`, `bootstrap-config` and `@/lib/db`.
  - It does **not** depend on `media-generation` or `generation-plans`, and they do not depend on it (a boundary test). With the
    switch off, or no key, it makes no network call and nothing else changes.
- **`src/lib/device-key-file/` (new shared module, extracted per §M).** It holds `createKeyFile` and `createKeyFileFsAccess`, moved out
  of `media-generation`.
  - `media-generation/key-file.ts` becomes a thin wrapper that keeps its own error text. Its existing tests must pass unchanged.
  - `gemini-media` uses its own file, `gemini-media.key`, never the RunPod one: clearing RunPod keys deletes that file.

### 2.2 Storage (schema v83, additive)

**`gemini_credentials`** (singleton `id='default'`):
- `ciphertext`, `iv`, `auth_tag`, `key_hint` (last 4 characters), `status` (`ok` | `payment_required`), `verified_at`, `updated_at`.
- Device-local.

**`gemini_media_jobs`:**

| Column | Meaning |
|---|---|
| `job_id` | PK `gm_…` |
| `channel_id` | |
| `request_id` | nullable; UNIQUE (`created_by`, `request_id`) |
| `kind` | `image` \| `video` |
| `model`, `prompt`, `params_json`, `inputs_json`, `request_hash` | |
| `status` | `queued` \| `submitting` \| `running` \| `done` \| `failed` |
| `remote_name` | Veo operation name |
| `estimate_usd`, `cost_usd`, `cost_basis` | `usage` \| `price_table` \| `not_charged` \| `unknown_outcome` |
| `outputs_json`, `error`, `error_code` | |
| `attempts`, `next_attempt_at` | |
| `created_by` | `factory` |
| `created_at`, `submitted_at`, `finished_at`, `updated_at` | |

- Indexes: (`status`, `next_attempt_at`) and (`created_at`).
- Device-local, classified in `snapshot/contracts.ts` and `youtube-data-policy`.

**Settings:** `app_settings` key `gemini_media_settings`, JSON.

| Setting | Default |
|---|---|
| `enabled` | **false** |
| `maxUsdPerJob` | 1 |
| `maxUsdPerDay` | 5 |
| `maxUsdPerMonth` | 50 |
| `maxActiveJobs` | 10 |

- Device-local in this slice; the limits are per computer (RISK below).
- Reading is forgiving per field, the same as media settings.

### 2.3 Money

- Prices are the §1.1 tables as constants, `GEMINI_PRICES_AS_OF = "2026-10-09"`. All amounts are USD with 4 decimals, through one
  helper added to `shared-money`: `ceil4(x) = Math.ceil(x·10⁴ − 1e-9) / 10⁴`. It is used for every estimate and every cost: always
  up, and the epsilon keeps 0.06555 → 0.0656 exact in floating point.

**Image estimate:**
- `imageTokens(size) × imageRate`
- plus `(ceil(promptChars/3) + 1120 × inputImages) × inputRate`
- plus `2000 × textRate` (thinking allowance)
- then `ceil4`.

**Video estimate:** `pricePerSecond(model, resolution) × durationSeconds`.

**Cost after the job:**
- **Image with `usage`:**
  - `total_input_tokens × inputRate`
  - plus image-modality output tokens × imageRate
  - plus (other output tokens + `total_thought_tokens`) × textRate
  - basis `usage`.
- **Image without `usage`:** per-image price × images saved, basis `price_table`.
- **Video:** the estimate, basis `price_table`.
- **Blocked, 400 or 402:** 0, basis `not_charged`.
- **Interrupted or expired after the request may have reached Google:** the estimate, basis `unknown_outcome`.

**Spend (local calendar, like media):**
- `today` / `month` = Σ `cost_usd` of finished jobs created in the window, plus Σ `estimate_usd` of active jobs (reserved).

### 2.4 Jobs

**Create** (`createJob(input, actor)`) is serialized by one promise-chain lock held on `globalThis`, so that two creates cannot both
pass a limit. The MCP route, the Web routes and `instrumentation.ts` are separate Next.js bundles: a module-level lock would be one copy
per bundle, which is why `media-generation` keeps its core on `globalThis`.
1. Parse with a strict schema.
2. Run the per-model rules (§2.5).
3. Check `enabled` → `gemini_disabled`.
4. Check the key → `gemini_key_missing`.
5. Check the channel workspace → `gemini_workspace_unavailable`.
6. Resolve every input in `Sent to YTM`:
   - png/jpg/jpeg/webp only;
   - ≤ 7 MB each, ≤ 12 MB in total (base64 inflates by 4/3, and the inline request limit is about 20 MB);
   - read now, with the identity checked;
   - any failure → `gemini_input_unavailable`.
7. Compute the estimate.
8. Check the limits, in this order: per job, per day, per month, active jobs → `gemini_limit_exceeded {limit, limitUsd?,
   spentUsd?, estimateUsd}`.

Then:
- **`requestId` already used:** with the same `request_hash` it returns that job; otherwise `gemini_request_exists`.
- **`dryRun`:** returns `{ estimateUsd, allowed, refusal? }` and stores nothing.
- **Otherwise:** inserts a `queued` row and returns it.

The input bytes are not stored. The worker re-reads them, with the same proofs, and fails the job if a file changed (sha256 differs).

**Worker** (`tick()`, from `instrumentation.ts` every 5 s, its own loop and try/catch):
- At most 3 jobs in flight per process.
- **Image:**
  1. CAS `queued` → `submitting` (attempts + 1), then one gateway call (timeout 5 min).
  2. On success: write each final image as `image-N.<ext>` (from mime) under `From YTM/gemini/<jobId>/`, through `.part` and rename,
     with sha256.
  3. Register each as a `generated_image` asset.
  4. Write `manifest.json` last.
  5. Mark the job `done` with its cost.
- **Video:**
  1. CAS `queued` → `submitting`, `startVideo`, store `remote_name`, status `running`.
  2. Poll every 10 s.
  3. When done: download to `video-1.mp4`, register a `generated_video` asset (new `ASSET_TYPES` value), write the manifest, mark the
     job `done`.
- **Retry:** an HTTP 429, 408 or 5xx answer, or a connection that never reached Google (DNS, refused, TLS), goes back to `queued`
  with backoff of 30 s, 2 min and 8 min. After 3 attempts the job is `failed`. A video poll failure is retried until 47 h after the
  start.
- **A timeout is not a retry.** A request that was sent and then timed out (`TimeoutError`; 5 min for an image) may have completed
  and been charged at Google. It becomes `failed gemini_timeout`, cost = estimate, basis `unknown_outcome`, with no automatic retry:
  the operator resubmits with a new `requestId`. The gateway child tells the two transport failures apart.
- **Response shape.** The Interactions answer is read from `steps[]`, falling back to `outputs[]`, because Google's pages disagree
  after the May 2026 revision. A `status` other than `completed` with no final image part is a failure, never a wait.
- **Blocked content → `gemini_blocked`, cost 0.** This covers:
  - a 2xx answer with no final image part;
  - a `status: failed` / `errors[]` answer;
  - an HTTP error whose `error.code` is one of Google's generation-blocked codes: `safety`, `recitation`, `language`,
    `prohibited_content`, `spii`, `blocklist`, `image_safety`, `image_prohibited_content`, `image_recitation`, `image_other`,
    `content_blocked`, `no_image`.

  It is kept apart from `gemini_invalid_request` so the operator knows to change the prompt, not the call.
- **Switch off while queued:** `failed gemini_disabled`, 0. Running videos are still collected, because they are already paid for.
- **Boot sweep:** a job left in `submitting` → `failed gemini_interrupted`, cost = estimate (`unknown_outcome`). A `running` video
  resumes polling.
- **`media-idle`** (`stop.sh`) refuses a stop while a job is `submitting`.
- **`isBusy`** (idle shutdown) counts queued, submitting and running jobs.

**Manifest:**

```
{ schema: "ytm.gemini-job-manifest", schemaVersion: 1, jobId, channelId, kind, model, prompt, params,
  inputs: [{ role, path, bytes, sha256 }], status: "done", estimateUsd, costUsd, costBasis, createdBy,
  createdAt, submittedAt, finishedAt, device: { deviceId, hostname },
  outputs: [{ path, kind, mimeType, bytes, sha256, assetId, note }] }
```

Every field is copied explicitly. No key, ever.

### 2.5 Per-model rules (`gemini_invalid_params`, before anything is stored)

- **Prompt:** 1–10 000 characters for images, 1–4 000 for video.
- **Images:**
  - `size` must be in the model's list (Lite: 1K only).
  - `aspectRatio` from the list.
  - `inputs.images` ≤ 14.
- **Video:**
  - `aspectRatio` 16:9 | 9:16.
  - `resolution` 720p | 1080p | 4k (4k not on Lite).
  - `durationSeconds` 4 | 6 | 8; 1080p and 4k require 8.
  - `referenceImages` ≤ 3: not on Lite, requires 8, and is not combined with `firstFrame`.
  - `lastFrame` requires `firstFrame`.
  - `personGeneration` is optional: `allow_all` | `allow_adult`.

### 2.6 Errors

**New `DomainErrorCode`s**, with their HTTP status and en/ru text:

| Code | Status |
|---|---|
| `gemini_disabled` | 409 |
| `gemini_key_missing` | 409 |
| `gemini_key_invalid` | 422 |
| `gemini_payment_required` | 409 |
| `gemini_limit_exceeded` | 409 |
| `gemini_request_exists` | 409 |
| `gemini_job_not_found` | 404 |
| `gemini_input_unavailable` | 422 |
| `gemini_workspace_unavailable` | 409 |
| `gemini_invalid_params` | 422 |
| `gemini_unavailable` | 503 |

**Job `errorCode`s** (stored, not thrown): `gemini_blocked`, `gemini_invalid_request`, `gemini_rate_limited`, `gemini_unavailable`,
`gemini_payment_required`, `gemini_key_invalid`, `gemini_disabled`, `gemini_key_missing`, `gemini_interrupted`, `gemini_expired`,
`gemini_input_changed`, `gemini_timeout`, `gemini_output_failed`.

### 2.7 Factory MCP (Factory API 1.12.0)

| Tool | Kind | Input → output |
|---|---|---|
| `factory_gemini_get_status` | READ | → `{ enabled, keyConfigured, keyHint, keyStatus, gatewayEnabled, limits, spend: { todayUsd, monthUsd, activeUsd }, pricesAsOf, models: [{ model, kind, label, sizes \| resolutions, aspectRatios, durations, inputs, prices }] }` |
| `factory_gemini_create_job` | WRITE; a dry-run is a read | `{ channelId, kind, model, prompt, requestId?, dryRun?, image?: { size, aspectRatio, inputs?: { images[] } }, video?: { resolution, aspectRatio, durationSeconds, personGeneration?, inputs?: { firstFrame?, lastFrame?, referenceImages?[] } } }` → `{ job }` \| `{ estimateUsd, allowed, refusal? }` |
| `factory_gemini_get_job` | READ | `{ jobId }` → `{ job }`; `{ channelId?, status?, limit? }` → `{ jobs }` (newest first, ≤ 50) |

- The job view is `{ jobId, channelId, kind, model, prompt, params, inputs, status, estimateUsd, costUsd, costBasis, outputs:
  [{ path: "From YTM/gemini/<jobId>/…", kind, mimeType, bytes, sha256, assetId }], error, errorCode, attempts, createdBy, createdAt,
  submittedAt, finishedAt }`.
- The read-name pattern in `factory-server.test.ts` is widened to `gemini_(get|list)`.
- No tool sets the key, the limits or the switch. Those are Web only, as for RunPod.

### 2.8 Web

- New Settings sub-tab **Gemini** (`/settings/gemini`):
  - **Key card:** paste, check with Google, store, remove. The key is never shown; only `…abcd` and its status.
  - **Switch:** "Operator may generate (paid)", using the `ToggleSwitch` with a visible caption.
  - **Limits:** per job, day, month, active jobs.
  - **Spend:** today and this month.
  - **Recent jobs** (20): status, model, cost, file path, error.
- Routes, all behind the Web session and the mutation gate like the media routes:
  - `GET|PUT|DELETE /api/gemini-media/credentials`
  - `POST /api/gemini-media/credentials/test`
  - `GET|PUT /api/gemini-media/settings`
  - `GET /api/gemini-media/jobs`
- en and ru texts.

## 3. Acceptance criteria

Expected values are computed by hand from §1.1 and §2.

| AC | Requirement |
|---|---|
| AC-GM-01 | A stored key is encrypted under `gemini-media.key` and is never returned (only `keyHint`). PUT checks the key with Google first. 400/401/403 → `gemini_key_invalid` and nothing is stored (Google has answered a bad key with 400 `API_KEY_INVALID`). 402 → stored with status `payment_required`. DELETE removes the row and the key file. |
| AC-GM-02 | By default `enabled` is false. A create is refused with `gemini_disabled`, and no fetch happens. When enabled without a key: `gemini_key_missing`. |
| AC-GM-03 | Estimates. Nano Banana 2.1 2K, 300-char prompt, no inputs: 0.0504 + 100×1.5e-6 + 2000×7.5e-6 = **0.06555 → 0.0656**. Lite 1K, 30 chars, 1 input: 0.0336 + (10+1120)×0.25e-6 + 2000×1.5e-6 = 0.0368825 → **0.0369**. Pro 4K, 30 chars: 0.24 + 10×2e-6 + 2000×12e-6 = 0.26402 → **0.2641**. Veo Fast 1080p 8 s: **0.96**. Veo Lite 720p 4 s: **0.20**. Veo Standard 4k 8 s: **4.80**. |
| AC-GM-04 | Limits. Per day 5 with 4.50 spent today: a 0.96 request is refused `{limit:"per_day", limitUsd:5, spentUsd:4.5, estimateUsd:0.96}`. A job from yesterday counts toward the month only. An active job counts with its estimate. A dry-run returns the same verdict, stores nothing and skips the mutation gate. Two concurrent creates that each fit the day limit alone, but not together → exactly one row. |
| AC-GM-05 | Per-model rules (§2.5), each refused with `gemini_invalid_params` naming the field, before anything is stored. |
| AC-GM-06 | Inputs. `../x.png`, absolute paths, a missing file, `.gif`, more than 7 MB, or more than 12 MB in total → `gemini_input_unavailable`; no row, no fetch. A file changed between create and run → job `failed gemini_input_changed`, cost 0, no fetch. |
| AC-GM-07 | Image job. One Interactions request, with the model, `input` parts (text plus inline images), `response_format {type:"image", aspect_ratio, image_size}` and `store:false`. Thought-step images are skipped. Each final image is written under `From YTM/gemini/<jobId>/` with the right sha256 and registered as `generated_image`. The manifest is written before `done`. Cost from `usage`: in 1000 tokens, image out 1680, text out 0, thought 300, on 2.1 = 0.0015 + 0.0504 + 0.00225 = 0.05415 → `ceil4` **0.0542**. An answer read from `outputs[]` instead of `steps[]` gives the same files. |
| AC-GM-08 | Video job. `predictLongRunning` body: `instances[0].prompt`, `image`/`lastFrame` as `inlineData`, `referenceImages: [{ image: {inlineData}, referenceType: "asset" }]`, `parameters {aspectRatio, resolution, durationSeconds:"8"}`. The operation name is stored and the job is `running`. Polls happen until done. The download sends the key to the Google host only; the redirect target gets no key. The file is `video-1.mp4`, a `generated_video` asset; cost = the estimate. |
| AC-GM-09 | Failures. Image blocked (no image part, or a block reason) → `failed gemini_blocked`, cost 0. 400 → `gemini_invalid_request`, 0. 402 → `gemini_payment_required`, 0. 401/403 → `gemini_key_invalid`, 0. 429/5xx or a refused connection → back to `queued` with backoff; on the 3rd attempt `failed` (`gemini_rate_limited` / `gemini_unavailable`), 0. HTTP 400 with `error.code` `image_safety` → `gemini_blocked` (not `gemini_invalid_request`), 0. A sent request that times out → `failed gemini_timeout`, cost = estimate, `unknown_outcome`, not retried. A done Veo operation with an `error` or no sample → `failed gemini_blocked`, 0. |
| AC-GM-10 | Restart. A job in `submitting` at boot → `failed gemini_interrupted`, cost = estimate, `unknown_outcome`. A `running` video resumes polling. A video still unfinished 47 h after `submitted_at` → `failed gemini_expired`, cost = estimate. |
| AC-GM-11 | Idempotency. The same `requestId` and content → the same job and no new row. The same `requestId` with other content → `gemini_request_exists`. |
| AC-GM-12 | Switch off. A queued job → `failed gemini_disabled`, 0, never sent. A running video keeps being polled and collected. |
| AC-GM-13 | MCP. The three tools are in the closed lists with strict schemas. A write calls the gate first (gate closed → nothing reached). A dry-run and the reads skip the gate. Capabilities show 1.12.0. |
| AC-GM-14 | Boundaries. No file outside `media-gateway` contains the Gemini host. `gemini-media` imports neither `media-generation` nor `generation-plans`, and vice versa. Every gateway call goes through `authorize("gemini_api")`; the toggle off → `media_gateway_disabled`. |
| AC-GM-15 | `operation-lock media-idle` exits 1 while a Gemini job is `submitting` and 0 otherwise, including on a database without the table. |
| AC-GM-16 | Schema v83 converges when run twice. Both tables are classified. The en/ru keys are in parity. |

## 4. Out of scope (later, each its own item)

- Omni Flash video, the Batch API, Veo extension, multi-turn editing.
- Generation-plan integration (Gemini outputs as plan attempts on the review screen). A Gemini attempt can already be reported by
  copying the file to `Sent to YTM` and using `factory_plan_report`.
- Owner-started jobs from the Web UI.
- Limits shared between the two computers (settings sync).
- Carrying the key to another computer as a `.ytmkeys` file.

## 5. Risks

- **Limits per computer.** Two computers each allow their own day and month amounts. The account-level guard is the AI Studio monthly
  spend cap. This will go into TECHNICAL_DEBT.
- **Interrupted image calls.** A synchronous image call cut by a restart may be charged with no file. It is counted at its estimate,
  and `stop.sh` refuses while one is in flight.
- **Prices in code.** Prices are code constants dated 2026-10-09; a price change needs a code change. Costs are estimates from the
  official table, not Google's bill.
- **Preview models.** The Veo models are `-preview`: their names or behaviour may change.

## 6. Order of work (one branch, `feature/gemini-media`)

1. `device-key-file` extraction (media tests unchanged).
2. Gateway child and its tests.
3. Schema v83, `db.ts` helpers and the db test.
4. `gemini-media` contracts, schemas, services, worker and adapters, with tests AC-GM-01..12 and 14.
5. Factory MCP tools, route wiring and tests (AC-GM-13).
6. `media-idle` and `isBusy`, plus the `instrumentation.ts` loop (AC-GM-15).
7. Web routes, the Settings sub-tab and en/ru texts.
8. Docs: ADR 0035, `interfaces.md`, SYSTEM_MAP, ARCHITECTURE, TECHNICAL_DEBT, BACKLOG, ROADMAP_STATUS.
9. Full validation, two independent review rounds, then the merge request to the owner.

## 7. After the merge (owner)

1. Create a key in AI Studio, link billing, top up at least $5, and set the monthly spend cap.
2. Paste the key in Settings → Gemini, set the limits and turn the switch on.
3. One live test, only with the owner's yes: one Nano Banana 2.1 1K image, about $0.04.

## 8. Changed while building

- **Key routes** are `/api/gemini-media/key` and `/api/gemini-media/key/test` (not `/credentials`): the repository's `.gitignore`
  hides every `credentials/` folder. The overview is `GET /api/gemini-media`.
- **Output files** go through the shared crash-safe write (`atomic-json-file.writeFileAtomic`: a temp file, fsync, rename with the
  Windows retry) instead of a separate `.part` writer; the video download keeps its own `.part` stream in the gateway.
- **A job's channel** must be connected on this computer (the channels `factory_list_channels` shows); otherwise
  `gemini_workspace_unavailable`, like a channel without a workspace.
- **The worker loop** runs behind the device mutation gate (not during a snapshot import or in recovery mode), and its startup sweep
  runs on its first allowed tick.
- **`media_gateway_disabled`** is also a job `errorCode` (the owner's gateway toggle was off when the job was sent; cost 0).
- **Interactions API revision:** Google's May 2026 migration made `steps[]` the only response shape (the legacy `outputs[]` was removed
  on 2026-06-08), so no `Api-Revision` header is sent; the reader still accepts `outputs[]`.
- **The traffic-category test** (`db.test.ts`) pinned the category list; it now includes `gemini_api` (the new counter of §2.1).
