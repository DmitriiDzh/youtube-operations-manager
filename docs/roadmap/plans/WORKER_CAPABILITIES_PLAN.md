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

Stages 2–4 are planned in DEV-RESP-0040 and get their own sections here when they start.

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
