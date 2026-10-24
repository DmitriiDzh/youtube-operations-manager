# Restart when idle (BL-220, FO-REQ-0038)

- **Request:** FO-REQ-0038 (Factory Operator; owner, Operator Telegram 2532–2536): the server restarts itself when nobody works
  with it, instead of the developer asking around before every restart (AGENTS.md §N, owner msg 3420).
- **Plan sent:** DEV-RESP-0042. **Owner answers (Developer msg 3424):** 1) no Telegram note from the app (the developer reports
  restarts); 2) the button is in Settings → О программе; 3) a request still waiting after 24 h ends by itself.

## Design

- **A request** (one open at a time; a second request joins it) comes from:
  - the owner's button «Перезапустить, когда никто не работает» in Settings → О программе (`POST /api/restart-when-idle`, signed-in
    owner);
  - the developer's script `scripts/macos/restart-when-idle.sh`: it writes `restart-request.json` into the app-data folder, the
    same trust as `stop.sh` (the OS user), and the server takes it up on its next check.
- **The check** runs every 15 s while a request is open, on this computer, and lists every reason the restart must wait.
- **The restart:** when no reason is left, the server records `restarting` (version, schema, who asked, minutes waited) and
  sends itself SIGTERM. That is the same graceful stop as `stop.sh`, and launchd starts the next run, rebuilding first if `dev`
  moved. This happens only under the macOS system service (`YTOM_SERVICE_MODE=1`). Anywhere else the request is refused with
  `restart_needs_service`.
- **On boot:** a request left `restarting` becomes `done`, with the new version and schema. The card shows it as the last restart.
- **Holds:** `restart_holds`, 1–60 minutes, each with a reason and who set it (`factory`, `worker:<channelId>`, `owner`). A hold
  ends by itself at `until`, or earlier when released. Several can be active at once, and the owner can end any of them.
- **Settings:** «Тишина MCP перед перезапуском, мин», 1–30, default 3 (`app_settings`). It applies at the next check.
- **MCP:**
  - Factory API 1.30.0: `factory_hold_restart`, `factory_release_hold`, `factory_restart_status`.
  - Agent API 4.4.0: `agent_hold_restart`, `agent_release_hold`, `agent_restart_status`. A worker releases only its own holds;
    holds are logged in the worker log.
  - Status: `{ request | null, waitingFor[], holds[], lastRestart | null, quietMinutes, serviceMode }`.

## Acceptance criteria (written before the code)

- **AC-RI-01** With any one of the following on this computer, a request does not restart, and `waitingFor` names it:
  - a media session that is not finished;
  - a media job queued, submitted, generating or transferring;
  - a Gemini job queued, submitting or running;
  - an upload in progress;
  - a live stream starting, stopping or switching;
  - the operation lock;
  - an active hold;
  - an MCP call within the quiet minutes.
- **AC-RI-02** With none of them, the next check records `restarting` and sends the stop signal once. A finished 24/7 stream that
  is simply running is not a reason.
- **AC-RI-03** A hold of N minutes keeps the restart waiting until `until` or its release. An expired hold is ignored. Minutes must
  be 1–60 and a reason is required; anything else is `validation_failed`.
- **AC-RI-04** A worker can release only its own hold (`not_found` otherwise); the Operator only its own; the owner any.
- **AC-RI-05** The owner can cancel an open request. A request open for 24 h becomes `expired` and does not restart.
- **AC-RI-06** On boot, a `restarting` request becomes `done` with the running version and schema, shown as `lastRestart`.
- **AC-RI-07** Outside the system service, a request is refused (`restart_needs_service`) and nothing is stopped.
- **AC-RI-08** The quiet-minutes setting accepts 1–30 (default 3) and applies to the next check.
- **AC-RI-09** The script's request file is taken up once and removed. A malformed file is removed and logged, and never restarts.
