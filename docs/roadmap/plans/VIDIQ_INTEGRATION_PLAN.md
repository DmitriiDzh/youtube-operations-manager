# vidIQ integration plan (BL-278, ADR 0077)

Status: stage 0 (this plan, ADR 0077 and the backlog row). No code yet. The owner reviews the architecture and security choices
before stage 1. Branch: `feature/vidiq-integration`, shared by every stage (AGENTS.md §K.1); each stage is a complete working unit.

## 1. Goal

The owner wants vidIQ for finding new niches and for finding and analysing competitors (TG 4949). He decided on 2026-11-26: «Тогда
строим инфраструктуру для интеграции vidIQ. Пока сделаем на бесплатном тарифе. Потом при необходимости докуплю подписку.»
(TG 4953).

YTM gets one controlled path to vidIQ's research tools:
- one key, held in YTM;
- one allowlist, enforced in code;
- one credits budget and one cache, shared by the owner and the Producer;
- a ledger of every call.

The Free tier (150 credits a month) must be usable, and an upgrade to a paid plan must need only a new budget value.

## 2. External contract (spike 2026-11-26, real account, Free tier, 0 credits spent)

- **Interface.** MCP only, at `https://mcp.vidiq.com/mcp` (Streamable HTTP, server `vidiq-mcp` 1.0.0), with
  `Authorization: Bearer <api key>`. It works with `@modelcontextprotocol/sdk` 1.32.1, which is installed (package.json
  `^1.29.0`). vidIQ has no REST API.
- **Pinned contract.** `src/lib/vidiq-gateway/fixtures/tools-list.2026-11-26.json` holds the 87 tools of `tools/list` under an API
  key, with descriptions, input and output schemas and annotations. `fixtures/balance.2026-11-26.json` holds a `vidiq_balance`
  result. **The allowlist, the costs and the argument schemas below come from these files, not from memory.** A newer contract is
  a new dated fixture, never an edit of the old one.
- **Costs.** Each tool states "Cost: N credit(s) per call." in its description, and every result carries `_credits.used`.
- **Plans.** Free gives 150 credits a month, Boost 2000 and Max 6000. `vidiq_balance` is free; its fields are `type`,
  `totalCredits` (renewable plus add-on), `renewableCredits`, `maxRenewableCredits`, `renewableResetsAt`, `addOnCredits` and
  `maxAddOnCredits`.
- **Terms** (vidiq.com/terms, effective 2026-10-19). The scraping and extraction bans (§5(l), (q), (y)) and the intellectual-property
  bans do not apply to the MCP server "when used as documented". §5(t) forbids reselling or redistributing. Third-party platform
  data stays under that platform's terms, including storage limits.

## 3. Scope

**In scope:** decisions 1–10 of ADR 0077, built in three stages (§5):
- the gateway;
- the key;
- the ledger and the budget;
- the cache;
- the Settings card;
- the Producer tools;
- send-to-watchlist;
- the Research sub-tab.

**Out of scope:**
- **OAuth or account sign-in to vidIQ,** and linking any of our YouTube channels to vidIQ.
- **Every non-allowlisted vidIQ tool:**
  - generation (titles, thumbnails, images, video, music, chapters, comment replies, clips, video studio, compose, motion graphics);
  - media editing and upload;
  - voice and voice cloning;
  - coach messages;
  - bookmarks;
  - `update_competitors` and `list_competitors`;
  - own-channel analytics (`user_channels`, `user_videos`, `channel_analytics*`, `subscriber_insights`, `youtube_channel_audit`, A/B
    tests), since YTM has the Analytics API;
  - TikTok and Instagram tools;
  - transcripts, comments, search and preview;
  - feedback, extension and the scripting helpers.
- **Scheduled or automatic vidIQ calls of any kind.** There is no background job; every call is explicit.
- **Writing vidIQ data into Market Intelligence's snapshots, `research_evidence`, derived metrics, the research export, the device
  snapshot or the device sync.**
- **vidIQ tools for channel agents or the factory.**
- **Producer usage guidance or editorial advice on how to research niches** (AGENTS.md §B). This plan defines only the technical
  contract.

## 4. Allowlist (checked against the fixture on 2026-11-26)

All 18 tools the owner's list named exist under exactly these names. Nothing needed dropping or renaming.

| Tool | `readOnlyHint` | Pinned cost | Required arguments (fixture) | Cache TTL |
|---|---|---|---|---|
| `vidiq_keyword_research` | true | 5 | — | 24 h |
| `vidiq_channel_search` | true | 5 | — | 24 h |
| `vidiq_outliers` | true | 5 | — | 24 h |
| `vidiq_trend_categories` | true | 0 | — | 7 d |
| `vidiq_trending_videos` | true | 5 | `videoFormat` | 24 h |
| `vidiq_similar_channels` | true | 5 | — | 7 d |
| `vidiq_channel_stats` | true | 5 | `channelId` | 7 d |
| `vidiq_channel_performance_trends` | true | 5 | `channelId` | 7 d |
| `vidiq_channel_videos` | true | 5 | `channelId`, `videoFormat` | 7 d |
| `vidiq_get_channels_by_ids` | true | 5 | `channelIds` | 7 d |
| `vidiq_get_videos_by_ids` | true | 5 | `videoIds` | 7 d |
| `vidiq_video_stats` | true | 5 | `videoId`, `granularity` | 7 d |
| `vidiq_video_change_history` | true | 5 | `videoId` | 7 d |
| `vidiq_title_thumbnail_wins` | true | 5 | — | 24 h |
| `vidiq_comment_insights` | **false** (documented exception: asynchronous, creates a job; `idempotentHint` false) | 5 per `discover`/`validate`/new `raw`; 0 for `raw` with `cursor` | `mode` | 24 h, stored under the starting call once the job completes |
| `vidiq_video_earnings_estimate` | true | 5 | `videoId` | 7 d |
| `vidiq_balance` | true | 0 | — | never cached |
| `vidiq_job_poll` | true | 0 | `mcpJobId` | never cached |

**Argument rules**, applied by the gateway before anything is sent:
- **Accepted properties.** Only properties of the pinned input schema are accepted, and an unknown property is refused. The live
  schema must also accept the arguments and must not require a property the pinned one does not.
- **`userGoal` is stripped.** It is on nearly every tool and is never forwarded or cached: it would carry agent context to a third
  party and split the cache.
- **Canonical ids only.** A channel argument (`channelId`, each of `channelIds`, `excludeChannelIds`) must match
  `^UC[0-9A-Za-z_-]{22}$`; a video argument (`videoId`, each of `videoIds`, `seedVideoId`) must match `^[0-9A-Za-z_-]{11}$`. A
  handle or URL is refused with `vidiq_canonical_id_required`. The fixture allows handles; we narrow it, for the cache key and for
  `watchlist.add`.
- **Job ids.** `vidiq_job_poll` takes only an `mcpJobId` that this computer's ledger recorded as `job_pending`.

**Cost rule.** The pinned cost per tool, and for `comment_insights` per mode, lives in `contract.ts`. The live description's "Cost:"
sentence must parse to the same number:
- for a fixed-cost tool, `Cost: N credit(s) per call.`;
- for `comment_insights`, `Cost: 5 credits per discover, validate, or new raw search. Raw cursor pages are free.`

Unreadable or different text means the tool is refused (`vidiq_cost_changed`).

## 5. Stages

Each stage is a complete working unit, merged only with the owner's yes (AGENTS.md §K.2). Schema versions are "the next free one
when the stage is built" (127 today); the Producer API version likewise (1.34.0 today).

### Stage 1: gateway, key, ledger and budget, Settings card, inventory test

**Gateway, `src/lib/vidiq-gateway/`.**
- **Files.** `index.ts` (barrel), `client.ts` (an SDK `Client` plus `StreamableHTTPClientTransport`, URL constant, 60 s timeout, one
  request in flight per process), `contract.ts` (allowlist, pinned costs, pinned schemas and TTLs read from the fixture) and
  `fixtures/`.
- **Exports.** `listToolsChecked()` returns the live list and a drift report per allowlisted tool, free; the live list is kept an
  hour and re-read once before any drift refusal. `balance(key)` is free. `callTool(key, tool, args)` runs every check in ADR 0077
  decision 4, then calls, then returns `{ result, creditsUsed, isError }`. `pollJob(key, mcpJobId)` is free.
- **Argument validation.** JSON Schema validation uses `ajv`. It is already installed through the SDK; stage 1 declares it as a
  direct dependency instead of relying on a transitive one.
- **Errors.** Errors map to `DomainError` codes with fixed messages. A raw SDK or transport error is never logged or returned as it
  is, because it can carry request headers. The codes:
  - `vidiq_key_invalid` (401/403);
  - `vidiq_rate_limited` (429, with `retryAfterSeconds` when given);
  - `vidiq_unavailable` (5xx, network, timeout before sending);
  - `vidiq_outcome_unknown` (timeout after sending);
  - `vidiq_result_too_large` (a result over 256 KB is refused);
  - the drift codes of ADR 0077 decision 4.
- **Counter.** `recordGatewayCallOutcome("vidiq_api", …)` on every attempt (new `GatewayTrafficCategory`).
- **Inventory test.** No file outside the gateway references `mcp.vidiq.com` or imports `@modelcontextprotocol/sdk/client`, or a
  gateway child. Only `src/lib/vidiq-research/` imports the barrel.

**Key.**
- **Slot.** A new device-secret slot `vidiq` (`DEVICE_SECRET_NAMES`; hint: the last 4 characters).
- **Saving.** Save means verify with `balance`, then write. A refused key is not stored. Clearing deletes the slot and turns the
  switch off.
- **Routes.** `src/app/api/vidiq/*`. The key route is in `REMOTE_BLOCKED_PREFIXES` (Mac only, like `/api/cloud-credentials`).
  The status read never returns the key, only `state` and the hint.

**Feature module, `src/lib/vidiq-research/`** (`contracts`, `schemas`, `services`, `adapters`, `index`).
- **Switch.** `vidiq_enabled` in `app_settings`, default off. It can be on only with a saved key; the first verified save turns it
  on.
- **Budget.** `vidiq_monthly_budget_credits` in `app_settings`, default 150, integer 0–100 000.
- **Balance snapshot.** `vidiq_balance_snapshot` in `app_settings`: the last balance, its read time and the key's slot version, so
  a new key discards it.
- **Call order** (under one per-process lock):
  1. switch;
  2. key;
  3. gateway drift check;
  4. stated cost;
  5. preflight: refuse when the cost exceeds the budget left in the period (`vidiq_budget_exhausted`, with `details` `statedCost`,
     `remainingBudget`, `periodEndsAt`), or exceeds the snapshot's `totalCredits` after a free re-read if the snapshot is older
     than 10 minutes (`vidiq_insufficient_credits`);
  6. ledger row `pending` at the stated cost (the reservation);
  7. gateway call;
  8. row updated with `_credits.used` and the outcome;
  9. free balance read, recorded as `balance_after`.
- **Budget arithmetic.** Spent in the period = the sum of `credits_used` over rows that are `ok`, plus the stated cost of rows that
  are `pending`, `unknown` or `job_pending`. Refunds come from vidIQ's `_credits.used` or `refunded`. An overcharge (used above the
  pin) marks the tool drifted.
- **Period.** It ends at the snapshot's `renewableResetsAt` and starts one calendar month earlier, or it is the UTC calendar month
  while no snapshot exists.
- **Stage 1 consumers.** Stage 1 has no paid consumer: the owner's balance and «Проверить подключение» are free. Paid calls are
  exercised against the fake server (§7).

**Settings card,** in «Облачные API», with its own `FeatureErrorBoundary`:
- the key (`MaskedSecretInput`, added to `masked-secret-input.inventory.test.ts`), save and clear;
- the switch (`ToggleSwitch` with a visible label);
- the status: not configured, connected (plan type), key refused or unavailable;
- «Проверить подключение»: the free `tools/list` drift report, 18 rows marked ok or the drift code;
- the balance: total, renewable of max, add-on, resets at, with «Обновить»;
- the budget input, with what is spent in the period and what is left;
- the 20 newest ledger rows: time, caller, tool, credits, outcome, error code;
- every text a key in `src/lib/ui-text/locales/<every language>/`.

**Schema (stage 1, additive).** One table, `vidiq_ledger`:
- `id`, `at`, `caller` (`owner` | `producer`), `tool`, `args_sha256`, `stated_cost`, `credits_used` (null until known), `outcome`
  (`pending | ok | cache_hit | refused | failed | unknown | job_pending`), `error_code`, `job_id`, `balance_after`;
- an index on `at`;
- pruned to 90 days on insert, like `producer_call_log`;
- device-local in `SNAPSHOT_DEVICE_LOCAL_TABLES`, classified `not_api_data` (it holds hashes, names and numbers, no YouTube data).

The `app_settings` keys and the device-secret slot need no schema change.

**Requirement notes (stage 1).** A dated note in `PHASE_9_PLAN.md` §4/§16 and `FUTURE_PHASES.md` §5 citing TG 4949/4953 and ADR
0077 decision 9. Requirements are amended by a note, never rewritten.

### Stage 2: Producer MCP tools, cache, send-to-watchlist

**Cache** in `vidiq-research`:
- the key is SHA-256 of the tool plus canonical JSON of the arguments (sorted keys, `null`/`undefined`/empty strings dropped,
  `userGoal` dropped);
- TTL per tool (§4), capped at 30 days (ADR 0077 decision 6);
- a hit returns the stored result, costs 0 and writes a `cache_hit` ledger row;
- identical calls in flight share one request (single-flight);
- `refresh: true` skips the cache;
- expired rows are deleted on write and by the retention pass.

**Asynchronous jobs.** `comment_insights` returns `{ mcpJobId, status: "inprogress" }` and the ledger row becomes `job_pending`.
Polling through `job_poll`:
- `completed` stores the result in the cache under the starting call and marks the row `ok`;
- `failed`/`expired` marks the row `failed`, with credits 0 once `refunded` is true (still counted while the rollback is pending);
- `refunded` sets credits 0.

**Producer tools** (Producer-only, in `PRODUCER_ONLY_TOOLS`; a new `PRODUCER_VIDIQ_TOOLS` list pinned by the test):
- `producer_vidiq_tools` (READ, free): for each allowlisted tool, the cost rule, the pinned input schema without `userGoal`, the
  TTL and the current drift state.
- `producer_vidiq_call { tool, args, refresh?: boolean, maxCredits?: integer ≥ 0 }` (permission `VIDIQ_RESEARCH`). It refuses
  when the stated cost exceeds `maxCredits`, before anything else. Its answer:
  `{ source: "vidIQ (third-party estimate)", tool, cached, fetchedAt, creditsSpent, balance: { totalCredits, renewableResetsAt } | null, budget: { monthly, spentInPeriod, remaining, periodEndsAt }, job?: { mcpJobId, status }, data }`.
  Polling a job is `producer_vidiq_call { tool: "vidiq_job_poll", args: { mcpJobId } }`.
- `producer_vidiq_balance { refresh?: boolean }` (READ, free): the snapshot (re-read when `refresh`), the budget, the period and
  the Producer's 20 newest ledger rows.
- **Errors.** When the module is off, every tool answers `vidiq_disabled` (the tools stay registered, so the contract is stable).
  Without a key, `vidiq_key_missing`.
- **Contract.** `producer_get_capabilities` names `VIDIQ_RESEARCH`, and its sentence about spending money is amended to say that
  `producer_vidiq_call` spends vidIQ credits within the owner's budget. Producer API minor bump. `docs/interfaces.md` documents the
  three tools.
- **Call log.** Every call is in `producer_call_log`, plus the vidIQ ledger.

**Send-to-watchlist.** No new code path: the Producer uses the existing `producer_propose { kind: "watchlist.add",
competitorChannelId, reason }`. `agent-proposals` applies it with Market Intelligence's public `addToWatchlist` after the owner
approves it in the Web UI. Stage 2 adds an end-to-end test of that path, starting from a channel id taken from a fake
`similar_channels` result. `agent_create_market_research_request` is not used (§10, Q3).

**Schema (stage 2, additive).** One table, `vidiq_cache`:
- `cache_key` (primary key), `tool`, `args_canonical`, `result_json`, `credits_used`, `fetched_at`, `expires_at` (at most
  `fetched_at` + 30 days, enforced in the service and by a CHECK);
- device-local;
- classified `non_authorized` with clock `fetched_at` in `src/lib/youtube-data-policy/contracts.ts`, so the 30-day retention and the
  backup scrub cover it;
- left out of `research-export`.

### Stage 3: Research tab «vidIQ» sub-tab

- **Placement.** The Research tab gains a «vidIQ» sub-tab with its own `FeatureErrorBoundary`; it is hidden when the module is off.
- **Searches.** The owner runs the allowlisted tools from forms built on the pinned schemas: dedicated forms for `channel_search`,
  `similar_channels`, `outliers` and `keyword_research`, and a generic form for the rest. Each form shows the cost and "from cache"
  before the click.
- **Results.** Results show as tables labelled «Оценка vidIQ (сторонние данные)», kept visually apart from YTM's own observations.
- **Watchlist add.** A channel row offers «Добавить в список наблюдения» (a required reason). It goes through Market Intelligence's
  public `addToWatchlist` (`createdVia: "web"`), the owner's own act, so no proposal is needed.
- **Ledger.** Calls are made by the caller `owner` under the same budget and cache.
- **Schema.** None. UI texts in every language.

## 6. Acceptance criteria (from the requirement, AGENTS.md §L)

Expected values come from ADR 0077, the fixture and vidIQ's stated contract, never from the implementation's output.

### Stage 1

- **AC-VQ-1.1** With no key saved, the card shows "not configured", the switch cannot be turned on, and a service call returns
  `vidiq_key_missing`. Nothing is sent.
- **AC-VQ-1.2** Saving a key the fake server refuses (401) stores nothing and returns `vidiq_key_invalid`. The slot stays `none`.
- **AC-VQ-1.3** Saving a key the fake server accepts stores it, shows its last 4 characters, turns the switch on, and records the
  balance snapshot (150, resets 2026-12-26 from the fixture).
- **AC-VQ-1.4** **Sentinel.** With the key `vq_SENTINEL_7f3a9c`, after a save, a status read, a balance read, a drift check, a
  paid call, a refused call and a transport error (including an SDK error built with headers), the sentinel appears in no captured
  log line, API response body, error message or `details`, ledger row, `app_settings` value or MCP output (stage 2 adds its
  tools). It appears only as the Bearer header the fake server receives.
- **AC-VQ-1.5** A tool not on the list (`vidiq_coach_message_create`, `vidiq_update_competitors`, `vidiq_generate_titles`, an
  invented name) is refused with `vidiq_tool_not_allowed`. The fake server receives no `tools/call`.
- **AC-VQ-1.6** **Renamed tool.** The fake server's list lacks `vidiq_channel_stats` but has `vidiq_channel_stats_v2`: a call to
  `vidiq_channel_stats` is refused with `vidiq_tool_missing` after one re-read of the list. The drift report marks that row.
- **AC-VQ-1.7** **Schema drift.** The live schema of `vidiq_similar_channels` newly requires `region`: refused with
  `vidiq_schema_drift`. Arguments that fail the pinned schema (`size: "ten"`) or carry an unknown property: `vidiq_args_invalid`.
- **AC-VQ-1.8** **Annotation drift.** `vidiq_outliers` live reports `readOnlyHint: false`: refused with `vidiq_annotation_drift`.
  `vidiq_comment_insights` with `readOnlyHint: false` (as in the fixture) is accepted.
- **AC-VQ-1.9** **Cost drift.** `vidiq_keyword_research`'s live description says "Cost: 10 credit(s) per call.", or has no Cost
  sentence: refused with `vidiq_cost_changed`.
- **AC-VQ-1.10** **Budget exhausted.** With the budget 150 and 148 spent in the period, a 5-credit call is refused with
  `vidiq_budget_exhausted` (`statedCost` 5, `remainingBudget` 2). The fake server receives no `tools/call`. A 0-credit
  `vidiq_trend_categories` still runs.
- **AC-VQ-1.11** **Balance lower than budget.** The snapshot `totalCredits` is 3 and the budget is untouched: a 5-credit call is
  refused with `vidiq_insufficient_credits`.
- **AC-VQ-1.12** **Ledger.** A paid call whose result has `_credits.used: 5` writes one row with stated 5, used 5, `ok` and the
  following balance. A call answered `_credits.used: 0` with `isError` counts 0. A timeout after sending is recorded `unknown` and
  counts 5. No call is retried: the fake server sees exactly one `tools/call`.
- **AC-VQ-1.13** **Concurrency.** Two paid calls started together with 5 credits of budget left: exactly one is sent.
- **AC-VQ-1.14** **Module off.** With the switch off, every service entry returns `vidiq_disabled` and sends nothing. The rest of
  YTM's suite passes with the module's routes failing (a boundary test: no module outside `vidiq-research` imports it, and
  `instrumentation.ts` starts nothing for it).
- **AC-VQ-1.15** **Arguments.** A handle (`@name`) or URL as `channelId` is refused with `vidiq_canonical_id_required`. A
  `userGoal` argument is not in the request the fake server receives.
- **AC-VQ-1.16** **Inventory and boundaries.** A test file outside the gateway that names `mcp.vidiq.com`, or imports
  `@modelcontextprotocol/sdk/client`, makes the inventory test fail (proved by the test's own matcher over a sample string).
  `vidiq-research` and the gateway import nothing from `write-context`, `youtube-write-gateway` or `youtube-read-gateway`.
- **AC-VQ-1.17** **Mac only.** A remote (non-loopback) request to the key route is refused by `src/proxy.ts`.
- **AC-VQ-1.18** **Interface text.** Every text of the card is a key in every language (ui-text tests). The key input is a
  `MaskedSecretInput`.

### Stage 2

- **AC-VQ-2.1** **Cache hit.** A repeated `producer_vidiq_call` with the same tool and arguments (keys in another order, a
  different `userGoal`) within the TTL returns `cached: true`, `creditsSpent: 0`, writes a `cache_hit` row and sends nothing.
- **AC-VQ-2.2** **Refresh.** `refresh: true` sends and pays. After the TTL (24 h for `vidiq_outliers`, simulated clock) the next call
  sends.
- **AC-VQ-2.3** **Retention.** No cache row survives 30 days: the retention pass deletes a row with `fetched_at` 31 days ago. The
  data-policy classification test lists `vidiq_cache` as `non_authorized`. `vidiq_cache` is not in the device snapshot or the
  research export.
- **AC-VQ-2.4** **Asynchronous job.** `vidiq_comment_insights { mode: "discover" }` returns a job; the ledger row is `job_pending`
  and counted at 5. Polling to `completed` stores the result, the row becomes `ok` with 5, and the same call again is a cache hit.
  Polling to `failed` with `refunded: true` makes the row `failed` with 0. Polling an `mcpJobId` not in the ledger:
  `vidiq_job_unknown`, nothing sent.
- **AC-VQ-2.5** **Envelope.** Every successful answer carries `source: "vidIQ (third-party estimate)"`, `creditsSpent`, `budget`,
  `cached` and `fetchedAt`. `maxCredits: 0` on a 5-credit tool is refused before the budget check.
- **AC-VQ-2.6** **Errors.** The Producer tools answer `vidiq_disabled` with the module off and `vidiq_key_missing` without a key. A
  channel agent's and the factory's tool lists contain no vidIQ tool (pinned lists).
- **AC-VQ-2.7** **Capabilities.** `producer_get_capabilities` reports the new API version, the `VIDIQ_RESEARCH` permission and the
  three tools. Every vidIQ call is in `producer_call_log`.
- **AC-VQ-2.8** **Watchlist.** A UC id taken from a fake `vidiq_similar_channels` result, proposed with `producer_propose`
  `watchlist.add`, appears on the watchlist after the owner's approval through the existing review core. Without approval, nothing
  is added.
- **AC-VQ-2.9** **Sentinel and size.** AC-VQ-1.4 repeated over the three Producer tools' outputs. A result over the size cap
  answers `vidiq_result_too_large` and is recorded with its real `_credits.used`.

### Stage 3

- **AC-VQ-3.1** The sub-tab is hidden with the module off. With it on, each form shows the cost and whether the answer would come
  from the cache, before the click.
- **AC-VQ-3.2** Results carry the third-party label and sit apart from YTM's own data. «Добавить в список наблюдения» needs a reason
  and creates a watchlist entry through `addToWatchlist`. A budget refusal shows its code text and sends nothing.
- **AC-VQ-3.3** UI texts exist in every language. The tab works on a phone width (BL-254 phone layout, `MOBILE_UI_PLAN.md`).

## 7. Testing

- **Fake server.** All automated tests run against a local fake MCP server: the SDK's low-level `Server` over Streamable HTTP on
  `127.0.0.1` with an ephemeral port.
  - **`tools/list`.** It answers with the dated fixture verbatim, or with a per-test mutation of it (a renamed tool, a schema
    change, a flipped annotation, a changed Cost sentence).
  - **`tools/call`.** It answers scripted results built from the fixture's output schemas, with chosen `_credits.used`, `isError`,
    401, 429, 5xx, a delay past the timeout, or an asynchronous job script.
  - **Auth and logging.** It checks the Bearer header and records every request, so a test can assert that nothing was sent.
- **URL injection.** The gateway's URL is injected through its dependencies only in tests; production has no setting for it.
- **No live calls.** No test reaches `mcp.vidiq.com`, no test reads a real key, and ad-hoc scripts that import `@/lib/*` run with a
  temporary `HOME`.

## 8. Live acceptance budget

Live calls are made only after a stage merges and the server restarts, by the owner or with his yes, on the Free tier: **at most 5
paid calls (about 25 credits) across all stages,** plus free `vidiq_balance`, `tools/list` and `job_poll` calls.

- **Stage 1:** key save (free balance), «Проверить подключение» (free list). 0 credits.
- **Stage 2:** `vidiq_similar_channels`, `vidiq_keyword_research` and `vidiq_comment_insights { mode: "discover" }` (job and poll),
  3 paid calls (15 credits). A repeat of one of them proves the cache (0 credits). `producer_vidiq_balance` shows the ledger
  agreeing with vidIQ's balance.
- **Stage 3:** at most 2 paid calls through the sub-tab (10 credits), one of them sent to the watchlist.

## 9. Risks

- **MCP-only contract drift.** The server is 1.0.0 with no published REST contract. Tools, schemas, annotations and prices can
  change without notice. Mitigation: pinned contract, fail-closed refusal per tool, a drift report in Settings and
  `producer_vidiq_tools`, and an update procedure (new dated fixture, pins reviewed, tests rerun). Refusing a drifted tool is the
  intended outcome.
- **Unpublished rate limits.** Mitigation: one request in flight per process, no automatic retry of paid calls, and a 429 surfaced
  as `vidiq_rate_limited`. Measured limits go into the architecture document after the live acceptance.
- **The Free cap.** 150 credits is about 30 research calls a month. Mitigation: the cache, the budget, `maxCredits`, and the cost
  visible before a click. Upgrading changes only the budget value.
- **Uncertain outcomes.** Counting `unknown` at the stated cost can under-use the budget. That is accepted: it never over-spends.
- **Untrusted result text.** vidIQ results contain text addressed to the agent ("follow and relay them"). It is passed as `data`
  under a source label, with a size cap. New RISK entry in stage 2.
- **Third-party estimates.** Earnings and growth numbers are vidIQ's estimates. Mitigation: the label on every answer and screen,
  and no storage as YTM evidence or metrics.
- **The account is shared with vidIQ's own app.** The owner's use of vidIQ's web app spends the same credits. The balance check
  covers it; the budget counts only YTM's calls.
- **Terms change.** The terms version (2026-10-19) is recorded here. Each fixture refresh re-reads §5 and the MCP clause.
- **Key exposure.** The key is covered by the device-secrets store (RISK-131) and the sentinel tests. TECHNICAL_DEBT gains a line
  in stage 1 if a new gap appears.

## 10. Open questions (for the owner, before or during stage 1)

- **Q1. Earnings estimates.**
  - *The conflict.* ADR 0077 decision 9 records the owner's change as decided. But the quoted owner words (TG 4949/4953) speak of
    niches and competitors and do not mention earnings, and `FUTURE_PHASES.md` §5 says revenue must not appear "even as an
    estimate".
  - *Options.* (a) Keep `vidiq_video_earnings_estimate` and `channel_search`'s `estimatedEarnings*` filters, labelled as
    third-party estimates. (b) Drop the tool and strip those filters.
  - *Recommendation.* (a) with the owner's explicit yes. Either choice is a one-line change in `contract.ts`.
- **Q2. Are vidIQ credits "paid calls"?**
  - *The conflict.* The Producer's capability report says no Producer tool "spends money by itself". BL-228 (ADR 0053) routes
    one-time paid calls through the owner's approval.
  - *Options.* (a) Credits within the plan's allowance are not a paid call: the budget is the gate, with a new permission
    `VIDIQ_RESEARCH`. (b) Every paid vidIQ call needs the owner's one-time approval.
  - *Recommendation.* (a). On the Free tier no money moves, and an add-on purchase is the owner's own act in vidIQ.
- **Q3. Discovery candidates.**
  - *The conflict.* Market Intelligence has no public method that accepts an external candidate; candidates come only from its own
    `search.list` runs. `agent_create_market_research_request` takes a search query, not a channel, and is not on the Producer's
    list.
  - *Options.* (a) Watchlist only, through the existing `producer_propose watchlist.add` (owner approves) and the owner's own add
    in stage 3. (b) Add a Market Intelligence public method `addExternalDiscoveryCandidate({ channelId, source: "vidiq", reason })`.
    That changes Market Intelligence, its data classification and its UI.
  - *Recommendation.* (a) now, (b) only if the owner wants vidIQ finds in the discovery list.
- **Q4. Key on the Mac only, or on both computers?**
  - *The question.* Device secrets stay on the computer they were typed on.
  - *Options.* (a) The Mac only. The Producer endpoint is Mac-only anyway, and one ledger is the whole picture. (b) Add a `vidiq`
    section to the cloud-credentials transfer file, and share the budget through a per-device report like ElevenLabs.
  - *Recommendation.* (a).
- **Q5. The budget period.**
  - *Options.* vidIQ's own renewal cycle (`renewableResetsAt`, the 26th today) or the calendar month.
  - *Recommendation.* vidIQ's cycle, so the budget and the real allowance reset together.

## 11. Documents per stage (DEVELOPMENT_PLAYBOOK §6.12)

- **Stage 0** (this commit): this plan, ADR 0077, its row in `docs/decisions/README.md`, the BL-278 row and the dated fixtures.
- **Stage 1:**
  - new domain files or sections in `docs/system/` and `docs/architecture/`, with a row in `docs/SYSTEM_MAP.md` and in
    `docs/ARCHITECTURE.md`;
  - `docs/architecture/persistence-tests.md` (schema);
  - `docs/system/component-status.md`;
  - `docs/TECHNICAL_DEBT.md` if a gap is accepted;
  - the dated requirement notes (§5 stage 1);
  - ui-text in every language.
- **Stage 2:**
  - `docs/interfaces.md` (the Producer tools, the version);
  - the architecture section (cache, retention);
  - `docs/TECHNICAL_DEBT.md` (the untrusted-result RISK).
- **Stage 3:**
  - `docs/system/web-ui.md` or the Research section;
  - ui-text.
- **Each merge:** `docs/ROADMAP_STATUS.md` and the BL-278 row.
