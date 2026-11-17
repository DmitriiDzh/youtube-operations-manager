> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 26. Remote media generation (RunPod + ComfyUI) — Phase 14, slice 1, branch `feature/phase-14-media-generation`

Plan and acceptance criteria: `docs/roadmap/plans/PHASE_14_PLAN.md`; research:
`docs/roadmap/plans/MEDIA_GENERATION_RUNPOD_COMFYUI_SYNCTHING_RESEARCH.md`. Slice 1 delivers the
foundation only — gateways, credentials, settings, Settings UI, operator CLI. Sessions (pods that are
approved per session and always terminated), jobs (ComfyUI prompts whose outputs are pulled over S3 into
`99 Data Exchange/From YTM/media/<jobId>/`), the Models panel and the agent tools are later slices.

- **Gateway (`src/lib/media-gateway/`).** One barrel over three children, one per external API
  product, each checking the single "Media gateway" toggle and recording a traffic event: `runpod-api.ts`
  (RunPod REST **v2** at `api.runpod.io/v2` — v1 at `rest.runpod.io` retires on 2026-11-15), `runpod-s3.ts`
  (RunPod's S3-compatible network-volume API, signed by the hand-written SigV4 in `sigv4.ts`, verified
  against the official AWS test vectors rather than adding the AWS SDK), `comfyui-api.ts` (the ComfyUI
  server behind RunPod's HTTP proxy, bearer token per session). `inventory.test.ts` fails the suite if any
  production file outside the gateway names a runpod.io host, or imports a child instead of the barrel.
  There is deliberately no "stop pod" function anywhere: a stopped pod's disk is billed at twice the
  running rate, so the only idle state this app knows is "terminated".
- **Credentials (`src/lib/media-generation/`, owner instruction 2026-10-05).** The RunPod API key and the
  optional S3 key pair are entered only in Settings → Cloud APIs (Settings → RunPod before BL-193, Settings → Media before slice 6), encrypted as one AES-256-GCM blob in
  `media_credentials` (schema v50, singleton, device-local: not in `SNAPSHOT_TRANSFERRED_TABLES`, not in
  `sync-gateway`). **The encryption key is a file the app creates itself** (`media-generation.key` in the
  app-data directory, written through `writeJsonFileAtomic`, mode 0600), not an environment variable —
  unlike `ai-connections`/`cloud-connection` (ADR 0008). A database copied to another machine has no
  matching key file and reads as `{ configured: false, reason: "key_file_missing" }`; no decryption is
  attempted. A read never creates the key; only the operator's save does. Decryption happens inside the
  service for the duration of one call and the plaintext reaches only the gateway factory. No route, CLI
  command, log line or (future) agent tool returns a secret; the public status carries the key's first
  characters, the S3 key id (RunPod's `user_…`, not a secret) and `verifiedAt`.
- **Settings.** One JSON blob under `app_settings.media_generation_settings`, validated by
  `mediaSettingsSchema` (defaults in `DEFAULT_MEDIA_SETTINGS`). Catalog-backed values are checked live on
  save: the datacenter must be in `GET /catalog/data-centers`, the GPU in `GET /catalog/gpus`, the network
  volume must exist and sit in the chosen datacenter (`media_settings_invalid`); numeric limits:
  `watchIntervalSeconds ≥ 15`, `idleMinutes ≥ 1`, `maxUsdPerDay > 0` (AC-P14-19). Setting a catalog value
  before credentials exist is refused (`media_generation_not_configured`), never silently accepted.
- **Operator surfaces.** `src/app/api/media-generation/*` (session required, mutating methods behind
  `src/proxy.ts`'s device gate), the Production section and Settings → RunPod (slice 6; `production-panel.tsx`, `media-generation-settings.tsx`: every
  RunPod call is an explicit click — Load / Test / Create — never on mount; creating a volume goes through
  `ConfirmDialog` with the monthly price), and `src/cli/media.ts` (`npm run media -- …`), a separate entry
  point from the main CLI (AGENTS.md §M) with the same gates (Operator CLI access; device mutation gate for
  `volume-create`/`pod-create`/`pod-terminate`/`s3-rm`). Scripts under `scripts/media/` wrap this CLI so a
  secret is never an argument or an environment variable (AC-P14-20).
- **Independence (AGENTS.md §M).** With no credentials the feature answers "not configured" and makes no
  outbound call; nothing else in the app imports it. Residual risks: RISK-106, RISK-107.
- **One core per process (review rounds 3–4).** `createMediaGenerationCore()` returns a `globalThis`
  singleton per scheduling mode: `background` for everything inside the web process (the watch loop, every
  route, the in-app MCP endpoint of ADR 0013), `detached` only for the operator CLI, so the in-flight job
  set and the serialized pulls-list writer are shared by every caller in the process and a job is never
  polled twice. A detached core never polls a job itself -- the web watch loop re-attaches to it
  (`resumeInFlightJobs`, run BEFORE the idle check so the first poll counts as activity; it also resumes
  stuck `transferring` rows, which need only S3, and fails a submitted/generating job whose session is
  gone instead of leaving it "in flight" forever). A transient "cannot receive outputs" (workspace
  unmounted, gateway off) keeps the job `transferring` for retry up to 24 h; the boot sweep fails only
  queued/submitted/generating jobs and leaves `transferring` ones to the resume. The pod's name is
  deterministic (`ytm-media-<sessionId prefix>`), so a pod created in the instant before the `starting`
  write is still found and terminated (and billed to the session) by the boot sweep. The S3 gateway gives
  body transfers a 30-minute budget (the abort signal also cuts the body stream) and metadata calls 60 s.
  The daily cap's day is the operator machine's local day. Web `POST /sessions` and `POST /jobs` refuse a
  `channelId` that is not a connected channel (AGENTS.md §F); the MCP path asserts the bound channel.
- **Orphan-proofing (review round 5).** A `createPod` call can fail after RunPod created the pod (timeout,
  dropped connection): sessions and model pulls both name their pods deterministically
  (`ytm-media-<session prefix>`, `ytm-models-pull-<pull prefix>`) and look the pod up by name through the
  cursor-paged `listPods` before concluding "no pod"; the start wait re-checks the pod on every ComfyUI
  poll so a container that dies while booting aborts within one interval; a pull's pod is confirmed gone
  before the pull is terminal (the volume stays "busy" until then); a job cancelled while its submit was
  in flight has its prompt withdrawn (`/queue delete` or `/interrupt`); a `queued` row is swept only
  after a 5-minute grace period. The janitor deletes BY LEDGER ONLY: a key under `exchange/` goes only
  when its `media_exchange_files` row says the file is local -- a failed or cancelled job's leftovers,
  which may be a finished generation nobody recorded, stay for the operator (`scripts/media/s3.sh`).
  The SIGINT/SIGTERM terminate is best-effort (Next.js owns the exit); the boot sweep is authoritative.
- **Abandoned starts and truthful outcomes (review round 6).** `media_sessions.stopping_outcome` (schema v53)
  records the terminal status a `stopping` row is heading for (`done` / `failed` / `interrupted`), so a stop
  retried by the watcher or the boot sweep ends with that status and the original `stopReason` (an aborted
  start never reads as `done`; "max USD reached" survives a restart). The watcher reconciles an `approved`/
  `starting` row whose approve request died once it is older than start + stop timeout + 2 min (pod
  terminated, session `failed`, cost recorded) -- before, such a pod billed until a manual restart while
  `hasOpenPod` blocked the idle shutdown. The boot sweep keeps an `approved` row without podId `approved`
  (error recorded) while RunPod is unreachable, because only that state triggers the deterministic-name
  search; an EXITED pod whose termination is unconfirmed stays `stopping` instead of `interrupted` on trust.
  The pulls list is read-modified-written in ONE libSQL write transaction (`updateMediaModelPullsJson`,
  `BEGIN IMMEDIATE`) and merged per pull, so the operator CLI (a separate process) and the web watch loop
  never drop each other's pull; `GET /models` and the CLI `models` are read-only (`listPulls`) -- only the
  watch loop advances pulls, so a read verb never terminates pods behind the device mutation gate's back.
  A download that fails verification is removed from the workspace folder (the remote copy stays for a
  retry); a transfer resumed from the ledger still registers the asset, reusing an entry an earlier attempt
  may have created (`findAssetByLocalPath`). A ComfyUI history entry without a `status` block but with
  outputs is `completed`; `agent_get_media_session`'s list filters by channel in the query. Dead surface
  removed: `uploadImage`/`viewUrl` on the ComfyUI client, `listMediaExchangeFilesByJob`.
- **Bounded billing and submit-time checks (review round 7).** `media_sessions.last_seen_alive_at` (schema v54)
  is written at readiness and on every watcher tick that finds the pod alive; when a reconciliation (boot
  sweep, watcher, operator Stop) finds the pod ALREADY gone, the billable window closes at that last
  sighting, not at `now()` (the row's `error` says so and defers to the RunPod invoice) -- a pod killed by
  hand hours before a reboot no longer eats the daily cap. A pod still alive is billed to its confirmed
  termination as before. `createJob` resolves the channel's workspace folder BEFORE any ComfyUI call
  (`media_workspace_unavailable` at submit, as the agent contract promises; no GPU minute spent on a job
  that could never land); a 400 from `/prompt` is stored with ComfyUI's own `error`/`node_errors` text
  (`describeComfyRejection`, bounded to 2000 chars); history outputs are filtered to `type: "output"` (a
  PreviewImage's `temp` files are neither pullable nor a reason to mark the job partial) and a prompt that
  saved nothing fails. `startPull` refuses a key that already exists on the volume (the poll would call it
  done on the first tick); the boot sweep is no longer awaited in `register()` (the watch loop waits for
  it instead, so a slow RunPod cannot hold HTTP startup for minutes); S3 object paths use the SigV4
  encoder for the wire URL too; `findAssetByLocalPath` is one indexed lookup
  (`getCreativeAssetByReference` → `assetCatalog.findAssetByReference`), not a channel-wide scan; the
  CLI `janitor` accepts only the bare `--delete` switch.
- **Closed race, shared lifecycle, bounded polling (review round 8).** AC-P14-18 (no GPU session while a pull
  writes the volume) had a window: both sides checked, then wrote. Now a pull RESERVES its record (podId
  null) before its `createPod` and re-checks the open pod after; an approve re-checks the pull after its own
  `approved` write (which `hasOpenPod` counts) and puts the request back to `pending` if one slipped in --
  whichever wrote second sees the other. A reservation with no pod past a 2-minute grace is adopted (pod of
  its deterministic name) or voided by the poll. `pod-lifecycle.ts` holds the ONE terminate-and-confirm and
  find-pod-by-name implementation sessions and pulls both call (AGENTS.md §M). The job poll loop credits
  session activity only for a prompt ComfyUI confirms (history, or `/queue` every 15th empty poll) and fails
  fast when the prompt is neither queued, running nor in history (ComfyUI restarted) instead of billing to
  the generation deadline. A THROWN per-object S3 failure during transfer keeps the job `transferring` for
  the retry window (a verdict such as "outside the job's folder" stays a note). Template defaults are
  validated against their own type/bounds/enum at import (`checkParameterValue`, shared with job params);
  `output_node_ids_json`/`node_count` (schema v55) are derived at import/update so a listing never
  re-parses graphs; `createAssetCatalogCore` wires `getAssetByReference` (round 7 had added it to the
  services only); S3 query strings use the SigV4 encoder (a space is `%20`, never `+`).
- **The volume lock and the last guesses removed (review round 9).** AC-P14-18 is now a CONSTRAINT, not a
  protocol: `volume-lock.ts` is the one database-enforced "network volume is busy" lock (one
  `app_settings` row, `media_volume_lock`, whose primary key makes the insert the atomic test-and-set). A
  session takes `session:<id>` before its `approved` write and `finish()` releases it with the terminal
  write; a pull takes `pull:<id>` before its reservation and releases it with its terminal write. An
  acquire that finds a holder asks the holder's module whether it is still active and steals a stale one
  (crash between the terminal write and the release). Every future writer to the volume takes the same
  lock. Disabling the media gateway is refused while the lock has an active holder (the toggle gates the
  only path that can terminate that pod). A failed `createPod` whose name lookup ALSO fails leaves the
  session `approved` (slot and lock kept, error recorded) -- the watcher repeats the search; a pull in the
  same situation keeps its reservation; neither frees the volume on a guess. The abandoned-start margin is
  5 min (derived from the approve request's real worst case, not 30 s over it). Stored settings with one
  invalid key keep every valid key (the spend cap included) and default only that key. A remote key with a
  `.`/`..` segment (an untrusted Save-node subfolder) is never HEADed, pulled or deleted; an output pulled
  earlier but not cataloged is cataloged on the retry; a template rename does not bump the version that job
  provenance records (only a graph/parameter change does).
- **Lock row never assumed, settled pulls never resurrected (review round 10).** `tryAcquireMediaVolumeLock`
  re-inserts when the read-back is null (the holder released between the no-op insert and the read):
  `acquired` is true only with the caller's own row in the table. After `createPod`, a pull records its pod
  only if its reservation is still `running` -- one settled by another process meanwhile (a cancel from the
  web UI while the CLI was inside `createPod`) keeps its verdict and the just-created pod is terminated.
  An output not yet visible in the S3 view of the volume, or read short, is a THROWN transient (the job
  stays `transferring` within the retry window), never a verdict. A template parameter may not target
  `filename_prefix`; `min` is enforced for string/text parameters; a datacenter change re-validates and
  re-prices the kept GPU; `models-pull.sh` quotes manifest values like `buildPullCommand`; the Settings
  card imports `NETWORK_VOLUME_USD_PER_GB_MONTH` instead of restating it.
- **Readiness, activity cadence and settings drift (review round 11).** `getSystemStats` is "up" only with
  ComfyUI's documented `system`/`devices` shape (a proxy's placeholder 200 is not). While ComfyUI confirms
  the prompt (history, or `/queue` on every 15th empty poll), EVERY poll credits session activity, so the
  1-minute minimum idle timeout cannot fire mid-generation. Approve refuses a request whose saved
  GPU/datacenter/price no longer match Production → Setup (`media_settings_invalid`): the estimate, the cap
  check and the record must describe the pod that is billed. Settings refuse a GPU the catalog does not
  offer in the chosen datacenter (`gpu.dataCenters`). A Save node whose `filename_prefix` is a link is
  refused at import. A Stop whose terminate throws records the cause on the `stopping` row. The money
  fields of the Settings card are controlled text inputs (`parseMoney`: "2.5" and "2,5", never a native
  number widget, per the project's settings-widget rule); the Jobs card polls only `/jobs` every 5 s and its
  context every 60 s. `src/lib/shared-async` holds the one `sleep` (unref'd for the detached CLI) and
  `round2`; `key-file.ts` has no `this`.
- **The route that was never committed, and verdict vs. outage (review round 12).** `.gitignore`'s
  `credentials/` pattern had swallowed `src/app/api/media-generation/credentials/` (the GET/PUT/DELETE
  route, `credentials/test` and their test) -- un-ignored and committed; without it no RunPod key could be
  saved on another checkout. `updateMediaModelPullsJson` is a compare-and-swap (guarded UPDATE / INSERT ON
  CONFLICT DO NOTHING, re-applied on a lost race), the single-statement idiom `db.ts` uses everywhere
  instead of a cross-connection transaction. The ComfyUI gateway distinguishes `comfyui_rejected` (a 4xx
  with a JSON body: ComfyUI's own verdict, 422) from `comfyui_unavailable` (5xx, a proxy's HTML, a
  timeout, 502); the poll loop fails at once on the former and retries only the latter. A 0-byte HEAD is
  "not there yet" (never recorded, never deleted). A `transferring` job that cannot be received backs off
  exponentially (15 s → 10 min cap, per process) instead of being re-driven every tick for 24 h.
  `getRunningSession` answers null for an unknown session id (never a throw out of the resume loop);
  `holdsVolumeLock` counts only a session past its `approved` write, so a lock left by a failed approve
  write is stale; `templateId` is validated against the account's templates like the other three pod
  inputs; `finish()` builds the pod facts once.
- **The lock's own window, and the third writer (review round 13).** An owner acquires the volume lock
  BEFORE its row is visible (approve → `approved` write, pull → reservation), so for milliseconds it is
  not "active" to the staleness check: the lock row now carries its acquire time (`<owner> <epoch ms>`)
  and a not-visibly-active holder is stolen only once older than a 2-minute grace -- a fresh one is a
  conflict. Operator pods (CLI `pod-create`, `scripts/media/*.sh`) that mount the configured volume are
  the third writer: the passthrough takes `pod:<name>` (active while a live pod of that name exists; the
  terminate passthrough releases it). Readiness requires the S3 key pair (outputs travel over S3 only),
  and `createJob` resolves the S3 client before submitting. The start wait marks the pod seen alive on
  every successful poll, so a pod that vanishes mid-start after a crash is billed to its last sighting.
  A history entry without a verdict (no `status`, no outputs) is in progress: progressed to `generating`
  and liveness-checked like an absent entry. A transfer window that ends with an output still not
  received is a failure, never a `done` missing an output. `credentials-test` is a gated CLI command (it
  writes `verified_at`). The pod template ships no default `COMFY_TOKEN` (`pod-start.sh` refuses to expose
  ComfyUI without one). `src/lib/shared-json` holds the one tolerant JSON reader set (`asRecord`,
  `asRecordOrNull`, ...) that the media gateway and the transcript provider both import.
- **Nothing that can strand a billing pod is editable while one is open (review round 14).** The guard that
  refused disabling the gateway now also refuses changing or clearing the credentials and switching the
  network volume or datacenter while the volume lock has an active holder (`assertVolumeFree`); limits,
  GPU and template stay editable (they bind only future sessions). An operator Stop on a `stopping` row
  retries the terminate with the row's OWN outcome and reason (an aborted start still ends `failed`); a
  Stop on an `approved` row whose approve request died runs the name search and terminate at once (the
  manual override of the watcher's abandoned-start path) and, while RunPod cannot be asked, keeps the slot
  and says so (`runpod_api_unavailable`). `releaseMediaVolumeLock` matches the owner by exact prefix
  (`substr`), never `LIKE`. `creative_assets_reference_idx` (schema v56) backs the per-output asset
  lookup. The pull command removes the Hugging Face CLI's download cache from the volume after the
  download and on any exit (a trap), as does `models-pull.sh`.
- **One transport, one pull implementation, no orphan on a late pod (review round 15).**
  `media-gateway/http.ts` is the one fetch → timeout → body → JSON-or-raw step both the RunPod and the
  ComfyUI children call (status mapping stays with each child). `comfyui_rejected` is definitive for
  `POST /prompt` only; a poll counts it like any other failure (ComfyUI never answers 4xx on `/history`;
  an intermediary does). `VolumeLock.acquire` reports "acquired" vs "already-held" (a store's `acquired`
  is true only for the row THIS call inserted), and an approve that loses the `approved` transition to a
  concurrent approve of the same session leaves the lock to the winner. A Stop on an `approved` row is
  refused while its approve request may still be inside `createPod` (no error on the row, not yet
  abandoned by age); a pod created after the row was stopped meanwhile, whose terminate cannot be
  confirmed, is written onto the row (`podId`, cost, how to terminate it) instead of being forgotten.
  `resumeInFlightJobs` credits session activity synchronously for each job it picks up (the watcher's idle
  check follows in the same tick). The operator terminate passthrough confirms the pod is gone before
  releasing `pod:<name>`. `models-pull.sh` drives `media model-pull` per manifest line and `media
  models-poll` (a gated command that advances the pulls) instead of re-implementing the pull shell.
- **A corrupt key file has a remedy; one rule each (review round 16).** An unreadable key file is reported
  as `key_file_invalid` (the card renders a Reset); Clear removes the row and -- only when the key file is
  unreadable -- the key file too (CLI: `credentials-clear`), so the next save starts a fresh key; a readable
  key file is kept (AC-P14-21). An output's path below `exchange/<jobId>/`
  is kept locally (two Save nodes with the same file name in different subfolders never overwrite each
  other). The generation deadline counts from the job's submit, not from each pickup. The lock row is
  JSON `{ owner, since }` matched by `json_extract` (a name with spaces, `_`/`%` or non-BMP characters is
  exact). Cancelling a RESERVED pull searches the pod by name first (a pod the dead reserver created is
  terminated, never orphaned). Community Cloud with a network volume is refused at settings time; only a
  CHANGED compute field is validated against the live catalog. The Jobs card explains when the open
  session belongs to another channel. The UI uses the core's own public types (`MediaSession`, ...), not
  hand copies. `isStartAbandoned` and `retryOrFail` are the single statements of the abandonment and the
  transfer-retry rules.
- **Tolerance where it was missing, no zombie prompts (review round 17).** The readiness wait tolerates up to
  five consecutive RunPod failures (a 502 or a timeout on `getPod` no longer terminates a healthy,
  almost-ready pod) and a DB hiccup on the seen-alive mark. A lost `POST /prompt` response is not a
  rejection: the queue is asked for the entry with `client_id ytm-<jobId>` (the gateway's `getQueue` now
  exposes `entries` with client ids) and the prompt is adopted; only `comfyui_rejected` fails the job as
  rejected. Every failure exit of the poll loop (deadline, a run of poll failures) withdraws the prompt
  (`withdrawPrompt`, the one interrupt/dequeue sequence a cancel uses too). The boot sweep moves a
  `running`/`starting` row to `stopping` before terminating, so nothing reads it as running meanwhile. A
  finished pull deletes `models/<folder>/.cache/**` over S3 (the pod may be killed before its own cleanup).
  `hasInFlightJobs` ignores a `transferring` job sleeping in its backoff, so the idle shutdown is not
  deferred for it. The integer Settings fields (minutes, seconds, GB) are controlled text inputs parsed on
  save (`parseInteger`), like the money fields.
- **Never on the strength of one GET (review round 18).** A pod the watcher cannot GET goes through
  `stopRow` (DELETE, then confirm) like every other exit, never straight to `interrupted` -- a transient
  404 on a live pod would otherwise free the slot and the lock while it bills. An operator pod whose
  `createPod` failed keeps the volume lock while a live pod of its name exists (or RunPod cannot be asked);
  only a confirmed "no pod" releases it. The pull poll evaluates each check on its own (a flaky S3 cannot
  hide a dead pod or the cap). An abandoned `approved` row with an adopted orphan pod is `stopping` while
  its terminate is confirmed (a concurrent Stop resumes that stop). RunPod's `createdAt` is parsed with
  `Date.parse` and falls back when unparsable (never a NaN cost that would silently disable the daily
  cap). A `done` stop of an already-gone pod carries the gone-note in its reason, not as an error. The
  janitor's documentation and the Jobs card say what it does: by ledger only, failed/cancelled leftovers
  kept. `job-run.sh --param-string` sends a numeric-looking text value as text. The credentials Reset
  dialog says the unreadable key file is removed too.
- **The window ends at OUR delete (review round 19).** `media_sessions.terminate_sent_at` (schema v57) records
  when this app's terminate DELETE went through; a retried stop whose DELETE answers 404 then bills to that
  moment (the pod died by our hand), not to the last sighting and not as "vanished on its own". A pod
  created after another party ended the row, whose terminate is confirmed, is written onto that row with
  its billed seconds (a pod on no row would hide spend from the daily cap). An intentional Stop while a
  session is starting is the approve request's outcome (the session as it ended), not a start error. A
  `done` job's `error` lists only outputs that were NOT received (an informational note stays on the
  output). The operator `createPod` resolves credentials before taking the volume lock, and a `pod:`
  holder check that cannot even resolve credentials counts as inactive (the lock ages out instead of
  blocking the very credentials needed). `updateSettings` derives one `revalidate` set from what changed
  (never by rewriting the caller's update); `finalCost` is `liveSeconds`/`liveUsd` frozen at `stoppedAt`.
- **Every terminate records its DELETE; a stopping row keeps its reason (review round 20).** The boot sweep's
  and the aborted start's terminates persist `terminateSentAt` like the watcher's, so a retry that finds the
  pod gone bills the crash-to-reboot hours to our DELETE. `stopRow` takes the caller's reason/outcome only
  from `starting`/`running`; a row already `stopping` keeps its own (a watcher tick racing an operator Stop
  never relabels the deliberate `done` as `interrupted`). Re-saving the same GPU re-prices it when its stored
  price is unknown (the remedy `requestSession`'s error names). The pull poll resolves S3 and RunPod on
  their own (an unusable pair never skips the dead-pod check or the cap). RunPod's 403 is
  `runpod_forbidden` (no permission for THIS resource: another account's pod, a restricted key), 401 alone
  is `media_credentials_invalid`. The janitor's `deleted` lists only what was really deleted; a dry run
  reports `wouldDelete`. The dead "another session is open" check in approve is gone (the unique open-slot
  index is the guarantee); `job-run.sh` refuses a `--param` without `=`.
- **Single owners (review round 21).** The session status lists live once, in the pure `contracts.ts`; `db.ts`
  imports them for the column enum and for freeing the open slot. The MCP tool input schemas are the core's
  `requestSessionInputSchema`/`createJobInputSchema` minus the server-set identity field. The boot sweep's
  already-gone path honors a recorded `terminateSentAt` like `stopRow`. `round2` moved to
  `src/lib/shared-money`. `verifyKey` probes `GET /pods?limit=1` (the scope the app needs). The job outputs
  cell shortens Windows paths too.
- **Sessions (slice 2, `sessions.ts`, `media_sessions` schema v51 + v53 + v54, owner decisions D2/D3).** A session is one
  pod. `requestSession` (operator now, agent in slice 5) stores a pending row with a LOCAL estimate
  (`gpuOnDemandPricePerHr × maxMinutes / 60`, the price captured when the GPU was saved -- zero RunPod
  calls, AC-P14-03) and `fitsToday` against the daily cap; a request that does not fit is still created
  and flagged. `approveAndStartSession` is Web-only (fenced by `session-approval-inventory.test.ts` from
  `src/mcp`, `src/cli`, `src/lib/agent-operations`): every precondition (ready, cap not used up, no
  other open session, credentials resolve) runs before the first transition (AC-P14-04); then
  `pending → approved → starting → running` as atomic `UPDATE … WHERE status IN (…) RETURNING` steps,
  the pod created from the template with the network volume at `/workspace`, port `8189/http` and a
  per-session `COMFY_TOKEN` (stored encrypted under the device key, never returned), `startedAt` =
  creation time (RunPod bills from there), `costPerHr` from the pod; the route blocks behind the shared
  progress overlay until `GET /system_stats` answers through the token proxy. A start that fails or
  times out terminates the pod and ends `failed`. *(Until slice 6: one open session per device via a UNIQUE index on
  `open_slot` -- superseded, see "Concurrent sessions" below.)* The
  watcher (`src/instrumentation.ts`, interval = `watchIntervalSeconds`, min 15 s) terminates on idle ≥
  `idleMinutes` (activity = job traffic, slice 3), minutes ≥ `maxMinutes`, usd ≥ `maxUsd`; a pod found
  `EXITED`/`ERROR` is terminated and the session `interrupted`, a vanished pod likewise (AC-P14-06/07).
  Termination is always `DELETE /pods/{id}` confirmed by a re-read; if RunPod cannot confirm, the
  session stays `stopping` (slot kept) and the watcher retries. Boot sweep terminates whatever a dead
  process left and marks it `interrupted` (AC-P14-08); the idle auto-shutdown and the SIGINT/SIGTERM
  handlers call `stopForShutdown` first (AC-P14-09; the signal path is best-effort, the boot sweep is
  the backstop). Cost: `usdCharged = secondsUsed × costPerHr / 3600`, seconds from pod creation to
  confirmed termination, live while running; the daily total sums sessions started today (AC-P14-17).
- **Templates, jobs and the exchange (slice 3, `jobs.ts`, schema v52, owner decisions D1/D4/D7).** A
  workflow template is an operator-imported ComfyUI graph in API format plus declared parameters
  (`name → nodeId/input`, type, bounds); import validates that every parameter targets an existing node
  input and that the graph has at least one Save node (an input named `filename_prefix`); editing bumps
  `version`, which a job's provenance records. `createJob` (operator now, agent in slice 5) requires a
  running session of the same channel, validates the values against the declared parameters before any
  ComfyUI call (AC-P14-10), writes them into a clone of the graph, rewrites every Save node's
  `filename_prefix` to `<jobId>/<base>` so the outputs land under `/workspace/exchange/<jobId>/` on the
  volume, submits `POST /prompt` through the token proxy and starts a background poll of
  `/history/{promptId}` (every 4 s, 2 h cap; each poll counts as session activity). `node_errors` or an
  `execution_error` mark the job `failed` with ComfyUI's message (AC-P14-11). On completion each output
  is pulled over the S3 API: `HEAD` → `GET` to a temp name + rename (the gateway hashes the stream) → a
  second SHA-256 of the file on disk must match (AC-P14-12) → ledger row in `media_exchange_files` →
  `DELETE` on the volume (a failed delete leaves `remoteDeletedAt` null for the janitor, AC-P14-13) →
  one `creative_assets` entry (`local_path`, type by output kind, provenance with template id+version,
  params, promptId, podId, gpu, cost, sha256). Outputs are written only under `<workspace>/99 Data
  Exchange/From YTM/media/<jobId>/` — the folder is resolved by the shared `src/lib/workspace-exchange/`
  module (extracted from research-export, AGENTS.md §M: same symlink/containment proofs as ADR 0019);
  without a configured workspace the job fails and nothing is pulled or deleted. An output reported
  outside the job's folder is never pulled or deleted. **Manifest** (FO-REQ-0002): `buildJobManifest` (explicit
  allowlist) → `manifest.json` written last via `.part` + rename; for `done` before the transition (a failed write is a
  transient transfer failure, retried within the window, then failed), for `failed`-with-folder after it, best effort;
  only files inside the folder are listed (an earlier workspace's file goes to `missing`); the name is reserved as the
  first segment below the job's folder (such an output is not pulled). A `done` transition that finds the row already
  moved (only possible from another process) is logged. Device = bootstrap `deviceId` + `os.hostname()`. **Janitor** (`cleanupExchange`, AC-P14-14): lists
  only `exchange/`, skips `exchange/in/` (reference inputs) and keys of unknown or non-terminal jobs,
  deletes a key only when its job is terminal and either its ledger row says the file is local or the
  job failed/was cancelled; dry run by default (Settings button, CLI `janitor`), real deletes daily from
  `src/instrumentation.ts` and on demand. Jobs left mid-flight by a dead process fail as interrupted at
  boot, right after the session sweep.
- **Factory media control (BL-132, ADR 0025, schema v61).** *Pulls* (`models.ts`): the Hub pre-check through the gateway
  child `media-gateway/huggingface.ts` (revision → commit, size, LFS SHA-256; gated/private refused) and a free-space check
  (`getNetworkVolume`) run before any pod; the CPU pod's script (`buildPullCommand`) downloads the commit into
  `ytm-staging/<pullId>/`, `sha256sum`s it, `mv`s it into `models/` only on a match and writes `ytm-pulls/<pullId>.json`;
  `pollPulls` settles a hashed pull ONLY on that verdict (+ S3 showing the verdict's size at the final key), and
  `finishPull` deletes the pull's staging/verdict keys. Pull records stay the `app_settings` JSON list (now 100 finished);
  the durable history is `media_control_events` (actor `owner|factory|sync`). *Usage/guard*: `jobs.modelUsage()` = this
  device's templates (factory: declared `models_json`; local: loader-node literals recorded at import) + every template the
  registry lists; `models.deleteModel` refuses the factory on any user or an unreadable registry, takes the exclusive
  volume lock as `delete:<id>` for the delete. *Registry*: `template-registry.ts` (format, pure checks, the known
  loader→folder map), `adapters/template-registry-fs.ts` (the only read inside a logical path: `media_templates`, direct
  regular files ≤ 5 MB, real path inside), `jobs.syncTemplatesFromRegistry` (serialized; fingerprint of index + listed
  files for the 60 s check in `src/instrumentation.ts`; last result in `app_settings`). Factory rows are written by
  `upsertFactoryMediaWorkflowTemplate`, whose `ON CONFLICT` update only applies to a `source='factory'` row. *Inputs*:
  parameter types `image|audio|video`; `createJob` resolves every input with `workspace-exchange.resolveSentToYtmFile`
  before the job row, then streams each with `RunpodS3Client.putObjectFromFile` (two passes: SHA-256, then the body with
  Content-Length) to `exchange/in/<jobId>-<param>-<name>` before the submit; ledger `media_exchange_inputs`; the janitor
  deletes such a key only by that ledger and only for a terminal job (other `exchange/in/` files stay "reference input").
- **Factory GPU sessions, fallback, capacity wait (BL-133, ADR 0026, schema v64).** `gpu-plan.ts` resolves the candidates (session plan,
  else device GPU + `gpuFallbackIds`; filtered by VRAM, price cap and the volume's datacenter via the catalog) and classifies a failed
  createPod (400 "could not be placed" = no capacity; 429/5xx/none = transient; else fatal). Every RunPod call (REST v2 and GraphQL, `createPod` too) first resends a 429 itself after its `Retry-After` (seconds or IMF-fixdate; 10 s when absent): at most 3 times and at most 60 s of waits per call, each resend authorized again (`runpod-api.ts` `rateLimited`); only then is the 429 the transient error above. `startApproved` loops over them, keeping the
  orphan-name search per attempt and recording each attempt in `media_capacity_attempts`; none placed → `waitForCapacity` (`approved →
  waiting_capacity`, no pod). `watchOne` retries a due waiting session in the background (`waiting_capacity → approved` with `approvedAt`
  restarted) and fails it after the wait; the loop ticks at least every `capacityRetrySeconds`. `approveInner` is shared by the owner's
  approve and `factoryStartSession`, which first checks the factory limits (`factorySpendUsd`: spend plus the remaining caps of active factory
  sessions, per local day and month); `stopInner` is shared by the owner's Stop and `factoryStopSession`; `getFactorySession` hides every
  non-factory session from the factory route.
- **CUDA host check and re-placement (BL-155, `docs/roadmap/plans/CUDA_HOSTS_PLAN.md`, FO-REQ-0007, no schema change).** Setting
  `minCudaVersion` (12.8 default; null and no session minimum (BL-159) = no create-pod filter and no host-version check -- the
  host's version is still read, for display only) → every createPod sends
  `gpu.allowedCudaVersions` = the known versions ≥ it (`cuda-host.ts`, pure; since BL-208 fix I `gpu.minCudaVersion` = the minimum
  instead -- RunPod matches the list exactly); no matching host is RunPod's "no capacity". Before
  `running` the start reads the host's CUDA -- from the pod answer itself (REST v2 `cudaVersion`, seen live 2026-10-08; the GraphQL fallback was removed 2026-10-20, RISK-134) -- on
  each RUNNING poll until it gets a value or the container is up (then unknown = not blocking), and always requires a `cuda` device
  with VRAM in `/system_stats`. A mismatch terminates the pod (confirmed, else the usual `stopping` path, no second pod), logs a
  capacity attempt `error` and places again from the candidate list -- at most `MAX_EXTRA_PLACEMENTS` = 2 more, each with its own
  start budget -- then fails `media_gpu_host_incompatible` (503); a re-placement that cannot create a pod fails too (never waits).
  Between placements the row goes back to `approved` with `podId` null (the name search covers a crash), `approvedAt` = now, and
  each placement's `starting` write sets `approvedAt` to its pod's placement time (`startAttemptSince` = the later of `startedAt`
  and `approvedAt` drives the abandoned-start clock). One billing window spans all placements: `startedAt` stays the first pod's,
  `costPerHr` is the dearest pod's, and a failure after a re-placement is billed to the last confirmed terminate. The replaced
  pod's `terminateSentAt` is kept on the `approved` row (a crash with no pod found closes the window there, else at the last
  sighting) and cleared by the next `starting` write; wherever a new pod's facts are written outside it (orphan adoption in
  `reconcileAbandoned`, `abortStart`, the swept-meanwhile path) they carry that pod's own DELETE time (or null) and a
  `lastSeenAliveAt` no earlier than its placement/sighting. The watcher stops a `starting` session (every session, not only
  re-placements) at `maxMinutes` counted from `startedAt` -- "max minutes reached (N) while starting". Factory jobs carry an
  `errorCode` derived from their error text (Factory API 1.7.0); release-when-done with every job failed says "all jobs failed".
- **A minimum CUDA per session and per template (BL-159, `docs/roadmap/plans/PER_SESSION_CUDA_PLAN.md`, FO-REQ-0011, schema v71).**
  `factory_media_start_session { minCudaVersion? }` or the started template's top-level `minCudaVersion` (call wins) is the session's
  own minimum (`media_sessions.min_cuda_version`; channel agents and the Web UI cannot set it). `startApproved` computes
  `higherCudaVersion(owner, own)` at every start and capacity retry -- the owner's setting is the floor (owner's decision) -- writes it
  at once to `used_min_cuda_version` (so a session waiting for capacity shows why), and uses it for createPod's CUDA filter (`gpu.minCudaVersion` since BL-208), the host
  check and the mismatch text. The host's CUDA is read with or without a minimum (without one a failed read, even a 401, is unknown)
  and written to `host_cuda_version` and to that placement's own capacity-log row (`insertMediaCapacityAttempt` returns the id,
  `setMediaCapacityAttemptHostCuda`); going back to `approved` for a re-placement clears it. `jobs.ts` `assertHostFitsTemplate`
  refuses `createJob` and `validateJobParams({ sessionId })` with `media_gpu_host_incompatible` when a template's
  `media_workflow_templates.min_cuda_version` is above the session's KNOWN host; `generation-plans` `checkJobs` passes that code
  through (not `plan_mismatch`). Strict template files: a build without BL-159 marks one carrying `minCudaVersion` invalid (RISK-116).
- **Concurrent sessions, Production section, balance (slice 6, ADR 0023 amendment 1, schema v58).** Requests are
  never refused for another open session; `approveSession` runs the preconditions, clears a crash-stale exclusive
  volume lock (`volumeLock.activeHolder`), then `pending → approved` as ONE `UPDATE` guarded by "active sessions <
  `maxConcurrentSessions`" and "no `media_volume_lock` row" (`approveMediaSessionGuarded`); a refusal re-reads to
  say which guard (`media_session_conflict`) or that the row moved on. The exclusive lock insert of a pull / operator
  pod is guarded the other way (`INSERT … SELECT … WHERE NOT EXISTS active session`), so a session and a pull can
  never both hold the volume (AC-P14-18/-23). Daily cap at approve: spent today + Σ other active sessions'
  `max(0, estimate − live)` + this estimate ≤ cap. The approve returns `{ session, started }`; the Web route answers
  202 with the `approved` row and the start runs in the background (failures land on the row). `watchTick`,
  `bootSweep`, `stopForShutdown` (parallel) and `hasOpenPod` iterate every open session; one session's failure is
  that session's tick result, not the loop's. Balance: `RunpodApiClient.getAccountBalance` -- legacy GraphQL
  `myself { clientBalance currentSpendPerHr spendLimit }`, else the v2 `/billing/pods` + `/billing/networkvolumes`
  totals with the reason (`GET /api/media-generation/balance`). UI: sidebar **Production** (after Content,
  `production-panel.tsx`: balance header; tabs Sessions, Jobs, Models, Workflow templates | Setup), sessions table
  with per-row Approve / Reject / Stop confirmed in the row and 5 s / 15 s polling; Settings → **RunPod** keeps only
  the credentials card.
- **Agent surface (slice 5; Agent API 3.4.0 on `dev`, one MINOR on top of Factory Operator's 3.3.0).** Seven `agent_*` MCP tools in a new `media_generation`
  capability domain, registered directly in `src/mcp/server.ts` against a request/read/job subset of the
  core (`MediaGenerationCoreSubset`): list templates, request a session, get session(s), get limits, create
  / get / cancel a job. Every tool asserts `channelId` is the caller's active (bound) channel first; a
  session or job of another channel is reported as not found; `agent_get_media_limits` discloses only this
  channel's open sessions (`openSessions`, 3.4.0) plus the device-wide `activeSessionCount`/`maxConcurrentSessions` and
  `deviceHasOpenSession`. Request,
  create and cancel pass the MCP mutation gate like `agent_create_collection_request`. No tool can approve,
  start or stop a session: those symbols are absent from `src/mcp` by inventory test (AC-P14-16). The CLI
  gets no agent commands (ADR 0013: the CLI is the operator's tool).
- **Models panel (slice 4, `models.ts`, owner decision D5).** `listModels` is one S3 listing of `models/` on
  the volume (never another prefix); `deleteModel` accepts only a `models/…` object key. `startPull` creates
  a CPU pod (`python:3.12-slim`, default flavor `cpu3c`, 2 vCPU) with the volume at `/workspace` whose
  command installs the Hugging Face CLI and downloads one file into `models/<folder>/`, then idles;
  `pollPulls` (every media watch tick -- never a GET or a CLI listing, which are read-only) terminates the
  pod as soon as the expected key has a size, or marks the pull failed when the pod died first, or timed
  out after 6 h -- never "stop". The in-flight list lives in `app_settings.media_model_pulls`
  (device-local; every mutation is one write transaction merged per pull, review round 6). A GPU
  session's approve is refused while a pull is running (shared volume, AC-P14-18); the CLI mirrors the
  panel (`models`, `model-pull`, `model-rm`).

**Live job progress (BL-144, 2026-10-06, owner msg 1887: real information, not estimates).** `jobs.ts` opens
ComfyUI's websocket **before** submitting a prompt (ComfyUI only sends events to sockets already connected with that
client id; the submit waits up to 5 s for it), keeps it through the unchanged `/history` polling loop, reopens a dropped
one at most every 15 s, and opens one late for a job picked up after a restart (ComfyUI re-sends its current node on
connect, without a prompt id). The socket goes through the media gateway (`comfyui-api.ts` `openProgressStream`: `wss://<pod>-<port>.proxy.runpod.net/ws?clientId=ytm-<jobId>`, the
per-session bearer token in the upgrade request's header, the same "Media gateway" toggle and traffic counter; an open
socket re-checks the toggle every 15 s and closes when it is off). The node count and names come from the template's
graph only while the template is at the job's version. ComfyUI
sends a prompt's execution events only to the client id it was submitted with, so the socket sees exactly that job.
`media-gateway/comfyui-progress.ts` parses `execution_start`, `execution_cached`, `executing`, `progress`, `executed`,
`progress_state`, `execution_success`, `execution_error`, `execution_interrupted`; `media-generation/job-progress.ts`
reduces them into `JobLiveProgress` (current node and its class type from the template graph, the node's steps, nodes done
and cached, a percent from nodes and steps that reaches 100 only on success). It lives in memory in the media core (one
per process on `globalThis`) and is attached to job reads as the optional `progress`. The stream never changes a job's
status: when it cannot open or drops, progress is `unavailable` and the job continues exactly as before (§M). Shown in
Production → Jobs (a bar per generating job, refreshed every 2 s) and Sessions ("Now" under each running session: the
current job, its progress, how many wait). **Live-verified 2026-10-07** on an RTX 4090 pod through RunPod's proxy with the
ACE-Step 1.5 2B turbo template: `execution_start`, `execution_cached`, `executing` per node, `progress_state` and the
KSampler's `progress` (8 of 8) all arrived, node 1 included (the socket connected before the submit). ComfyUI sends
nothing while a node works before its first step, so such a stretch shows only the node name.


## 29. Generation plans (BL-143, ADR 0029) — phase 1

- **Module:** `src/lib/generation-plans/` (contracts / schemas / services / progress / adapters/store / index). It depends on
  `media-generation` through a port (`PlanMediaPort`: get a session, link a session to a plan, check job params, create a job,
  read a job's outputs); `media-generation` imports nothing from it (test AC-GP-16).
- **Storage (schema v66, device-local):**
  - `generation_plans` holds the definition (stages, groups, items with job `params` and `seeds`) as one JSON document, changed only
    by a compare-and-swap on `revision`.
  - `generation_plan_results` holds external-stage reports, verdicts and imported attempts. Its key is (plan, stage, item,
    attempt), so a repeat replaces the row.
  - `generation_plan_events` holds the owner's re-run requests, group notes and plan writes, each with its actor.
  - `media_jobs.plan_id/plan_stage_id/plan_item_key/plan_seed` and `media_sessions.plan_id` link the media rows to a plan.
- **Derived, never stored:** in-app attempts are the linked jobs. Job status maps to queued/running/done/failed; a job whose
  error starts with "interrupted" is an interrupted attempt. Imported attempts are added unless a linked job carries the same
  ref. `progress.ts` computes, from those rows and the plan's sessions when a plan is read:
  - per-stage counts;
  - per-item `missing` (fixed: target − usable attempts; until_accepted: target − accepted − pending, capped by `maxAttempts`);
  - waiting-for-review attempts;
  - spend (final `usdCharged`, live cost while running);
  - budget warnings at 80 % / 100 %;
  - ETA from finished jobs on the current GPU type;
  - events with a `since` cursor.
- **Runs:** `runStage` / `rerun` check everything first: a running session the factory started, of the plan's channel, not
  another plan's; then each job's template and params (`validateJobParams`), and a `seed` parameter when seeds are used. Only
  then do they create jobs one by one. A create failure after the checks returns the jobs created so far and `stoppedAt`.
- **Review:** `reviewQueue` lists the attempts that passed the stage before `owner_review` (BL-153: with the plan's `reviewRejected`, also the playable attempts rejected there -- one rule, `reviewCandidates` in `progress.ts`, feeds the queue, `waitingReview`, todo, the notice and the badge; the shared peer report keeps its format and the reader derives passed/rejected with `validatorOfEntry`). `resolveAudition` picks the latest
  reported `auditionFile`, else the job's own output.
  - The audition route resolves that file through `workspace-exchange`: `resolveSentToYtmFile`, or the new
    `resolveFromYtmJobFile`, which accepts a file only inside `From YTM/media/<jobId>` after realpath.
  - It serves allowlisted types with Range support.
  - The player (`media-review-player.tsx`) loads `wavesurfer.js` and its regions plugin on mount and knows nothing about plans.

- **Phase 2 (other devices):**
  - `src/lib/sync-gateway/per-device-report` holds the shared report mechanics, used by `media-sessions` and `generation-plans`.
    The `media-sessions` report is version 2 since BL-148: an open session also carries its job counts and up to 5 unfinished
    jobs with BL-144 live progress (no `detail`), shown under "Other devices" (ADR 0028 amendment).
    Each device writes only its own report and keeps each peer's latest. A report older than the stored one, one dated in the
    future, or an invalid one is refused; a peer silent for 7 days is forgotten.
  - On the media watcher tick, `publishGenerationPlansShare` (in `generation-plans/index.ts`) first runs `applyPeerVerdicts`,
    then publishes `buildSharedPlans()` together with the outgoing verdicts.
  - A peer's audition is resolved by `resolvePeerAudition` from that peer's report, then proven inside this device's workspace
    by the same `workspace-exchange` resolvers.

- **BL-188 stage 1 (one shared list of media jobs, `docs/roadmap/plans/SHARED_MEDIA_JOBS_PLAN.md`):**
  - Family `sync-gateway/media-jobs` (+ `media-jobs-sync`), report `ytm-media-jobs` v1 on `per-device-report`: this computer's
    RunPod and Gemini jobs -- every unfinished one and finished ones of the last 7 days, at most 1000. Strict allowlist: ids,
    status, progress without `detail`, template/model label, plan/storyboard links, Gemini cost, times, an error **code**, and
    output paths relative to `99 Data Exchange/`. Never parameters, prompts, inputs, URLs or provider text.
  - Module `src/lib/media-jobs-pool/` reads both feature modules (`listJobsForShare` in `media-generation/jobs.ts` and
    `gemini-media/services.ts`) and the family; neither feature module imports it (tests in both directions). `publishMediaJobsShare`
    runs in its own 30 s loop in `instrumentation.ts` and writes only when the jobs changed (or every 5 minutes).
  - `GET /api/media-jobs?kind=&limit=` (active channel from the session) merges own jobs (full detail) with peers' (codes only),
    marks a peer silent for 5 minutes stale, and checks a peer's outputs in this computer's workspace copy with
    `resolveExchangeFile` (subdirs `media`, `gemini`) for the returned rows only.
  - Media's kind tabs show the list (`JobsCard`): a "Компьютер" column and filter when there are several computers. No schema
    change in stage 1.
- **BL-188 stage 2 (the same actions everywhere, schema v93, report v2):**
  - **Commands.** A click on another computer's job or session is stored on the clicking computer (`media_job_commands_out`) and
    carried in its report (`commands`, kept 7 days, ≤ 500): `cancel_job` (RunPod, or a Gemini job not yet sent), `create_job` (a
    RunPod run on that computer's running session of the active channel, with the template and parameters), `approve_session` /
    `reject_session` (a pending request). `POST /api/media-jobs/commands` checks the target against that computer's own report
    (job: active channel, still cancellable; session: from its `media-sessions` report, running for a run, pending for a
    decision, its channel connected here) -- `media_job_command_invalid` (409) otherwise; the computer itself is never a target.
  - **Applying** (`media-jobs-pool/commands.ts` `applyIncomingCommands`, on the pool tick in `instrumentation.ts`, skipped while
    an import/migration holds the lock or in recovery mode): commands addressed to this computer, oldest first; each is taken in
    the ledger `media_job_peer_commands` (`applying`) before anything happens, so a replay, a duplicate in two reports or a
    restart never applies it twice (a row left `applying` is reported as `command_interrupted` after 30 minutes, never retried;
    the ledger is kept 30 days, longer than any command stays in a report). A `create_job` or `approve_session` (both start spending)
    first seen more than 15 minutes after it was issued, or dated more than 5 minutes ahead, is `command_expired`; a
    `cancel_job` naming no channel is refused (`CHANNEL_NOT_AUTHORIZED`). Each command runs the service a local click runs: `media-generation` `cancelJob` /
    `createJob` (all its checks and limits, the storyboard gate) / `approveSession` (every device limit) / `rejectSession`,
    `gemini-media` `cancelJob`; a job of another channel than the command names is refused. The answer (`commandResults`, ≤ 1000)
    is a status and a code only, never an error text.
  - **Gemini cancel:** `queued` → `failed` `cancelled_by_owner`, nothing charged, by the same compare-and-set the worker's claim
    uses; `submitting` / `running` / finished → `gemini_cancel_too_late`. `POST /api/gemini-media/jobs/[jobId]/cancel` for own jobs.
  - **UI:** the row's Cancel and the run form's session list (own running sessions first, then other computers') work on every
    computer; the row shows «отправлено на … · ждёт подтверждения» (or «… не на связи с …»), then «выполнено» / «отказано — причина»;
    an unanswered run is shown as expired after 15 minutes. Other Devices offers Approve / Reject on a peer's pending request.
  - A version 1 build refuses a version 2 report: both computers update together.
- **BL-188 stage 3 (Factory read, Factory API 1.17.0):** `factory_jobs_list` (READ, no gate) calls `listMediaJobsForAgent`
  (`media-jobs-pool/index.ts`) over the pure `agentJobsList` (`services.ts`): this computer's jobs converted to the shared shape
  (the same window as its report) plus every peer's report, deduplicated, filtered (channel, source, kind, status, plan), newest
  first, `limit` 1-500 (default 100) with `total`/`truncated`, and per device `reportAgeSeconds`/`stale` (> 5 min). Codes only for
  every computer, this one included; the Operator's actions stay local (owner msg 2806, Q4).
- **BL-188 stage 4 (Gemini launch from Media, report v3; owner msg 2806 Q3):**
  - **Here:** `GeminiCreateCard` (`src/components/gemini-media-create.tsx`) in Media's Images / Video tabs -> `POST /api/gemini-media/jobs`,
    the Gemini module's own `createJob(..., "owner")` -- the same switch, key, model rules, inputs, storyboard gate and limits as
    `factory_gemini_create_job` -- with the active channel from the session (a body naming a channel is refused). "Оценить" is the
    module's dry run. The form's request is built by the pure `buildGeminiRequest` (`gemini-media-create-request.ts`).
  - **Elsewhere:** the same request as a `create_job` command with `source: "gemini"` and `gemini` (report v3; a v2 build refuses a
    v3 report, so both computers update). The executor runs `createGeminiMediaCore().createJob({ ...request, channelId, requestId:
    "cmd-<commandId>" }, "owner")`: the request id from the command means a create that ran but was not recorded as finished
    returns the same job, never a second paid one; the 15-minute expiry and the ledger apply as for RunPod runs; refusals come
    back as codes (`gemini_disabled`, `gemini_key_missing`, `gemini_limit_exceeded`, ...). The form shows the price-list figure
    for another computer (that computer computes its own estimate and limits).
  - The job list refreshes on the window event `media-jobs:changed` the form fires after a create or a send.
