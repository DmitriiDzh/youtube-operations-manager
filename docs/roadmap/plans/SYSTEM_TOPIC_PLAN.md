# HUB "System" topic: owner commands the Manager executes (BL-228)

Status: **assigned** (owner, Telegram msg 3598, 2026-10-27: «Делай обе задачи, System и по музыке. Каждую в своей ветке»).
Request: FO-REQ-0042 (Operator, with its answers of 2026-10-27). Reply: DEV-RESP-0043 Part 1 (questions Q1–Q6). ADR 0053 +
Amendment 1. **Scope changed** (owner msgs 3602, 3607; FO-RESP-0043 H1–H4, Q5, Q6): the hub relays, the Manager does only paid approvals.

## 1. Why

The Operator, the Producer and the channel agents run in Claude Code. Its auto mode accepts a permission only from the terminal,
so the owner's «да» on Telegram cannot stop a running factory job or approve a paid call. The owner wants to command these from
the HUB group's "System" topic, and the Manager (not an agent) executes them.

## 2. Scope (as amended, owner msg 3607)

The HUB bot is polled by the factory's hub (`hub_bot.py`). The hub keeps `status` / `stop` / `go` (FO-RESP-0043 H4). The Manager
makes no Telegram call and runs no factory script. It does exactly one thing: one-time paid-call approvals, each needing the
owner's `approve <id>` in the topic AND one Confirm in the Manager's Web UI.

1. **Module `src/lib/system-topic/`** (feature module, AGENTS.md §M; off by default; the switch only on the Mac service):
   settings (owner user id, group id, topic id, the switch, the requests folder), the relay secret (hash only), the audit of the
   relayed commands, the outbox, the requests and their state. Schema v111.
2. **Grammar:** `help`, `approve <id>`, `deny <id>`. `status` / `stop` / `go` get one line: "handled by the hub in each channel's
   topic". Anything else: "unknown command, see help".
3. **Relay (loopback only, `Authorization: Bearer <relay secret>`; FO-RESP-0043 H1):**
   - `POST /api/system-topic/inbound` `{updateId, messageId, chatId, threadId, fromId, date, text}` → `{replies: string[]}`. A
     message that is not the owner's in the configured chat and topic is dropped silently (counter only); a repeated `updateId` gets
     no second run or reply.
   - `GET /api/system-topic/outbox` → `{messages: [{id, text}]}`, each message handed out once (the hub polls every 5 s and posts).
   - The secret is generated in the Settings card, shown once, stored as SHA-256 and compared in constant time; "generate a new one"
     replaces it.
4. **Settings → AI agent → «System (Telegram)»:** the ids, the requests folder, the switch with a visible caption, the relay secret,
   the relay's state, the requests approved in the topic with Confirm / Deny (no native dialogs), the last requests and commands.
5. **No MCP tool.** Agents write the request file only; they never approve.

## 3–4. `status`, `go`, `stop`

Hub-side (FO-RESP-0043 H4). The Manager keeps none of the factory config, process-stop or launch logic planned here before.

## 5. `approve <id>` / `deny <id>` — one-time approvals (as amended)

- An agent writes `00 YT Operator/System/requests/<id>.json` (`format: 1`, `id` = the file name, `createdAt`, `requestedBy`,
  `action`, `args`, `costEstimateUsd`, `reason`). The scan (every 10 s while the feature is on) posts each new request once through
  the outbox: id, action, short arguments, the **Manager's own** estimate, the hash (first 8 hex of SHA-256 of the canonical JSON of
  `{action, args}`). A file that does not parse as JSON yet is read again next time; a wrong shape is refused once.
- Allowlist (the same schema and service code as the MCP tool, composed in `src/composition/system-topic-approvals.ts`):
  - `factory_media_start_session`: `maxMinutes`, `maxUsd` and `releaseWhenDone: true` required (Q5). Estimate = rate ×
    `maxMinutes` / 60, the rate being the session's `gpu.maxPricePerHr`, else its template's, else the saved GPU price; the post says
    "maxUsd $X is the hard bound". Refused over $2 (estimate or `maxUsd`), or when the factory switch, per-session, day or month
    limits would hold it. A start a device limit still holds is withdrawn (the factory stop path) and recorded `failed`.
  - `factory_gemini_create_job`: the Gemini module's dry-run estimate and limits; refused over $1; `dryRun` cannot be approved. The
    SHA-256 of each input file (frames, references) is part of the request's fingerprint; an unreadable one is refused at posting,
    a changed one at Confirm.
  - `factory_media_get_gpu_availability` (FO-RESP-0045): a free test action ($0), the tool's own schema, the same two steps.
  - Anything else is posted as refused.
- States: `posted` → `approved_in_topic` (the owner's `approve`) → `confirmed` (the Web Confirm, set before the call) → `done` /
  `failed`; also `denied`, `expired` (past 2 h from `createdAt`, or `createdAt` in the future), `refused`.
- Confirm re-checks: approved in the topic and not used, 2 h, the re-read file's `{action, args}` equal (canonical JSON) to the
  stored ones -- the 8-hex hash is display only --, the input files' fingerprint (full SHA-256), the schema, the cap and the
  limits. It runs with the STORED args (what the owner saw on the card), never the re-read file's. It runs the call in process, writes `<id>.result.json` atomically (`format`, `id`, `status: done | refused | failed |
  expired | denied`, `at`, `result` | `error`) and queues the result line for the topic. The Gemini job is created with the actor
  `owner (System)`; the media module records a factory session as `factory` (its own actor is fixed), and System's audit, result file
  and log name the owner.
- All state is in the DB; a restart neither forgets a use nor re-posts. At boot, a request confirmed before this process started
  and not in flight becomes `failed` (outcome unknown), with its result file.

## 6. Never

Show tokens, keys or the relay secret; publish, delete or reschedule videos; touch live streams, uploads or the Manager's own
process; run a shell or a factory script; call Telegram; execute any text that is not one of the commands; run a paid call without
the owner's Web Confirm.

## 7. Acceptance, worked out by hand (as amended)

- AC-SYS-01 A message from another user id in the topic: no reply, no audit row, the dropped counter rises.
- AC-SYS-02 The owner in another topic of the group (or another chat): ignored the same way.
- AC-SYS-08 A request created 2 h 1 min ago: `expired`, the tool is not called (also when confirmed at 2 h 1 min).
- AC-SYS-09 `approve` twice, Confirm twice: the tool is called once; the second Confirm and a later `approve` say "used".
- AC-SYS-10 The file's `args.maxMinutes` changed after posting: Confirm → refused (hash), the tool not called.
- AC-SYS-11 An estimate of $2.01 → refused; $2.00 → posted ($2.00/h × 60 min; $2.01/h × 60 min).
- AC-SYS-12 An action outside the allowlist is posted as refused and cannot be approved.
- AC-SYS-14 The relay secret is returned only when generated; it is in no log, view or other answer.
- Also: a Web Confirm without the topic `approve` is refused; a wrong bearer gets 401; a non-loopback call 403; a duplicate
  `updateId` gets no second reply; a non-owner message is a silent drop.
- (AC-SYS-03..07, 13 described the hub-side commands and the poller; they are dropped from the Manager's scope.)
- Live, with the Operator: a $0 approval twice, an expired one, after the hub relay is in place.

## 8. Stages

One branch, one merge: the module, the relay, the approvals and the card. The hub side is the Operator's (FO-RESP-0043 H3).

## 9. Risks

- The relay cannot prove the owner wrote a topic message: mitigated by the Web Confirm (RISK-136).
- The media module records the started session as the factory's (see §5).
