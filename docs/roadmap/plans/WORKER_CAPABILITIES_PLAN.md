# Channel workers: their real capabilities, limits and a log (FO-REQ-0037)

- **Request:** FO-REQ-0037 (Factory Operator, owner Telegram 2416 on the Operator's side) and PRD-REQ-0019 (Producer). Answer and the
  full audit table: DEV-RESP-0040 (`10 Developer Exchange/Inbox`, 2026-10-24).
- **Owner decisions:** Telegram msg 3384 (2026-10-24), the six questions of DEV-RESP-0040: 1 build stage 1 now; 2 keep `apply`'s real
  write for workers, logged; 3 `playlist_delete` owner-only; 4 privacy as a direct narrow write (stage 2); 5 paid work approved
  each time, "через продюсера" (to be clarified before stage 4); 6 the stale broadcasts are deleted by the owner in Studio.
- **ADR:** `docs/decisions/0048-channel-worker-writes.md`.

## Stages

| Stage | BL | Scope | Agent API |
|---|---|---|---|
| 1 | BL-215 | Complete capabilities inventory (EXECUTE for real writes, tied to the channel tool registry by a test); `public` refused for a worker's `playlist_create`/`playlist_update`; `playlist_delete` operator-only; worker action log (schema v107), Web UI card, `agent_list_worker_actions` | 4.0.0 |
| 2 | BL-216 | `agent_set_privacy` (videos and playlists, private/unlisted only) | 4.1.0 |
| 3 | BL-217 | `agent_*` versions of the Operator's channel tools (plans, storyboards, video numbers, live, channel translations, jobs, Gemini reads) | 4.2.0 |
| 4 | BL-218 | Paid work for workers (Gemini jobs, plan stages) with per-action approval | 4.3.0 |

Stages 2–4 are built on ONE branch, `feature/fo-req-0037-worker-stages`, and merged together (owner msgs 3392/3393/3395; stage 1
was merged alone at 1c91aac2 and is not restarted onto the live server until the rest is ready).

## Stage 1 (BL-215) -- acceptance criteria

Written before the code, from the owner's decisions and FO-REQ-0037's "Owner keeps", not from the implementation.

- **AC-WK-01** In a channel-bound agent session, `playlist_create` with `privacyStatus: "public"` is refused with
  `AGENT_PUBLIC_NOT_ALLOWED` before any credential resolution or YouTube call. `private`, `unlisted` and the default (private) are
  not refused by this rule.
- **AC-WK-02** The same for `playlist_update` with `privacyStatus: "public"`. An update without `privacyStatus` is not refused (it
  does not make anything public; the playlist keeps its current status, as today).
- **AC-WK-03** Outside an agent session (the owner's Web UI) both still accept `public`, unchanged.
- **AC-WK-04** `playlist_delete` is not registered in a channel session; the owner's Web UI delete is unchanged.
- **AC-WK-05** `agent_get_capabilities` in a channel session names every tool registered there, and no tool that is not; every
  capability names its tool(s). Each tool that can write to YouTube (`apply`, `playlist_create`, `playlist_update`,
  `playlist_add_videos`, `playlist_remove_videos`) is in a capability with permission `EXECUTE`. `grantedPermissions` is
  `["READ", "DRAFT", "EXECUTE"]`; `APPROVE` is never granted.
- **AC-WK-06** Every worker call of a YouTube-writing tool that would really write -- `apply` only with `dryRun: false`, every call
  of the four playlist tools -- leaves exactly one log row: time, the session's channel, token id, tool, target id, a short detail
  of what was asked, outcome `ok`/`error` and the error code. A refused call (for example AC-WK-01) is logged with its code.
  `apply` with `dryRun` omitted or `true`, and every read tool, leave no row.
- **AC-WK-07** A failure to write the log row never changes the tool's own answer (the YouTube write may already have happened).
- **AC-WK-08** `GET /api/channels/{channelId}/worker-actions` (signed-in owner only, 401 otherwise) returns at most 100 rows of
  that channel, newest first; rows of other channels never appear. Rows older than 90 days are pruned.
- **AC-WK-09** `agent_list_worker_actions` returns only the bound channel's rows.
- **AC-WK-10** The Settings → Channels row of each channel shows a «Действия воркера» list with every text in all UI languages.

## Not in stage 1

- No change to who may write what beyond AC-WK-01/02/04: `apply` and the other playlist writes stay as they are (owner, msg 3384).
- The log is device-local (like the Producer's call log); each computer shows the writes its own endpoint served.
- No before → after values in the log yet: the wrapper sees the request and the answer, not YouTube's previous state. Stage 2's
  privacy tool records the previous status itself.

## Stage 2 (BL-216) -- acceptance criteria

From the owner's answer 4 (msg 3384) and msg 3386/3389: a direct write, allowed by the owner's Live writes switch, never public.

- **AC-WP-01** `agent_set_privacy { target: "video" | "playlist", id, privacyStatus: "private" | "unlisted", dryRun? }`; any
  other `privacyStatus` (`public` included) is invalid input. The service refuses `public` again (`AGENT_PUBLIC_NOT_ALLOWED`).
- **AC-WP-02** A video must be in the bound channel's synced mirror (`not_found` otherwise, the same as a video that does not
  exist); a playlist must be one of the bound channel's (`not_found` otherwise).
- **AC-WP-03** A video with a `publishAt` (scheduled) is refused with `AGENT_SCHEDULE_OWNER_ONLY`, nothing written: changing its
  privacy would drop the owner's schedule.
- **AC-WP-04** The app's current broadcast of the channel (its stream is on, or an open segment's broadcast) is refused with
  `AGENT_LIVE_BROADCAST_OWNER_ONLY`. Finished recordings are allowed (PRD-REQ-0019's case).
- **AC-WP-05** `dryRun` defaults to true: the answer shows `previousPrivacyStatus` and `privacyStatus`, nothing is written. With
  `dryRun: false` a video goes through `video-details`' write (identity check, backup, Live writes, read-back, audit) bound to the
  previewed etag; a playlist through the playlist core (write-channel guardrail, ownership, Live writes).
- **AC-WP-06** A target that already has the asked status is not written (`changed: false`).
- **AC-WP-07** Every call with `dryRun: false` leaves one worker-log row with `previousPrivacyStatus` and `privacyStatus`.

## Stage 3 (BL-217) -- acceptance criteria

From FO-REQ-0037 item 2 ("the Operator abilities that can be scoped to a channel") and its acceptance ("a test call to Japan with
the Tropico token is refused").

- **AC-WF-01** Every worker version of a channel tool refuses an input naming another channel with `CHANNEL_NOT_ACTIVE`, before the
  module runs (create/get/list of storyboards, plans, video numbers, live, channel translations, jobs; an imported plan file).
- **AC-WF-02** A call by plan id of another channel's plan answers `plan_not_found`, the same as a missing plan; the own plan's call
  reaches the module.
- **AC-WF-03** Where the Operator's tool lets the channel be left out (live status, jobs list, Gemini jobs, plan list), the token's
  channel is put in -- a worker never sees another channel's rows.
- **AC-WF-04** Shared and paid things stay unreachable: models, templates, runtimes, GPU data and settings, sessions, the channel
  list, logical paths, `run_stage`/`rerun`/`move`, Gemini status and job creation -- and the channel's own translations (ADR 0047:
  only the owner and the Factory Operator save them; changing that is the owner's separate decision).
- **AC-WF-05** Exactly 26 tools, named `agent_*`, with the same input/output contracts as their `factory_*` originals (built by the
  factory server itself, not copied). Each write is a worker-log row.

**Decision -- the actor.** The modules keep recording `factory` for these writes: their synced shapes (the plans report's
`owner`, live/channel translation `updatedBy`) accept only `factory` / `owner`, and a new value would break the other computer
until both update. Who did it is in the worker log (tool, token, time, target). Paid runs and plan-linked jobs (which need a
factory session, ADR 0029 §4) are stage 4.

## Stage 4 (BL-218) -- acceptance criteria

Owner msg 3402 (to «сам или одобряю»): «может, как оператор» -- a worker starts paid work itself on the Operator's terms.

- **AC-WF-06** Ten more worker tools from the Operator's own: `agent_factory_start_session` / `_get_session` / `_stop_session` /
  `_create_job` / `_get_job` / `_cancel_job`, `agent_plan_run_stage`, `agent_plan_rerun`, `agent_gemini_get_status`,
  `agent_gemini_create_job`. A session another channel's, a job in it, a plan of another channel, or a Gemini job named for another
  channel is refused (`media_session_not_found` / `media_job_not_found` / `plan_not_found` / `CHANNEL_NOT_ACTIVE`); the own
  channel's calls reach the factory's code unchanged.
- **AC-WF-07** The terms are the Operator's, unchanged: a session approves itself only within the owner's factory limits and while
  the owner's factory-sessions switch is on (otherwise it waits for the owner); Gemini only within the owner's switch and limits.
  The limits are shared with the Operator (one budget). Each paid call is a worker-log row.
- **AC-WF-08** Nothing in `src/mcp` reaches the media core's session start/stop: the wiring lives in
  `src/app/api/mcp/factory-media-deps.ts` and the channel agents' route injects it (`session-approval-inventory.test.ts` unchanged).
  Without it the tools refuse.
