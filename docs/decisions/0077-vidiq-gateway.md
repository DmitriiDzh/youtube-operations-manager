# 0077. vidIQ research through one gateway: an API key only, allowlisted read tools, a credits budget and a bounded cache

Status: Proposed (owner TG 4949 and 4953, 2026-11-26). Stage 0: no code yet. The owner reviews the architecture and security
choices below before stage 1 starts.

**Date:** 2026-11-26. **Backlog:** BL-278. **Plan:** `docs/roadmap/plans/VIDIQ_INTEGRATION_PLAN.md`.

## Context

The owner wants vidIQ for finding new niches and for finding and analysing competitors (TG 4949). On 2026-11-26 he decided:
«Тогда строим инфраструктуру для интеграции vidIQ. Пока сделаем на бесплатном тарифе. Потом при необходимости докуплю подписку.»
(TG 4953).

A spike on 2026-11-26 used the owner's real account on the Free tier and spent 0 credits. It found:

- vidIQ has no REST API. Its only programmatic interface is the MCP server `https://mcp.vidiq.com/mcp` (Streamable HTTP, server
  `vidiq-mcp` 1.0.0). It accepts `Authorization: Bearer <api key>` and works with `@modelcontextprotocol/sdk` 1.32.1, which YTM
  already installs.
- Under an API key, `tools/list` returns 87 tools (pinned as `src/lib/vidiq-gateway/fixtures/tools-list.2026-11-26.json`). None
  of them writes to YouTube: there is no update-video, thumbnail, comment-reply, publish or authorize tool. YouTube writes exist
  only behind vidIQ's OAuth sign-in. Several tools do write to the vidIQ account or reach people: `vidiq_coach_message_create`
  sends a message to a human coach, and `vidiq_bookmarks_save`, `vidiq_update_competitors`, `vidiq_submit_feedback`, the
  generators and the uploads also write.
- Costs are stated in each tool's description ("Cost: N credit(s) per call."). Most research tools cost 5; `vidiq_trend_categories`,
  `vidiq_balance` and `vidiq_job_poll` cost 0. `vidiq_comment_insights` costs 5 per discover, validate or new raw search, and its
  raw cursor pages are free. Every result carries `_credits.used`. `vidiq_balance` returned
  `{"type":"limited","totalCredits":150,"renewableCredits":150,"maxRenewableCredits":150,"renewableResetsAt":"2026-12-26T14:01:17Z",
  "addOnCredits":0,"maxAddOnCredits":0,"_credits":{"used":0}}`.
- Free gives 150 credits a month, about 30 research calls. Boost gives 2000 and Max 6000. An upgrade keeps the same key.
- vidIQ's terms (vidiq.com/terms, effective 2026-10-19): the scraping and data-extraction bans (§5(l), (q), (y)) and the
  intellectual-property bans do not apply to the MCP server "when used as documented". §5(t) still forbids reselling or
  redistributing. Data that comes from a third-party platform stays subject to that platform's terms, including its storage
  limits.

What this collides with in the repository:

- **One gateway per API category** (AGENTS.md §G, the owner's standing rule). ADR 0007's read gateway is for YouTube-family
  clients only. ADR 0005's write gateway is the only YouTube writer. `wikipedia-gateway` and `social-gateway` (ADR 0068) are the
  pattern for an outside API.
- **The authorized writer list** (`docs/WRITE_AUTHORIZATIONS.md`). A vidIQ OAuth link to our channels would create an unlisted
  YouTube writer outside ADR 0005.
- **Phase 9 limits.** `docs/roadmap/plans/PHASE_9_PLAN.md` §4 and §16, and `docs/roadmap/FUTURE_PHASES.md` §5, say: no
  automatic discovery or crawling, no profitability conclusion, and no revenue figures for a competitor, "even as an estimate".
  Architecture §24 (Phase 13, owner decision D1) keeps other channels' YouTube data for at most 30 days and derives no metrics
  from it.
- **Typed secrets.** Since ADR 0042 they live in one store, `src/lib/device-secrets/`. Key inputs in Settings are
  `MaskedSecretInput`, never `type="password"` (BL-174 inventory test).

## Decision

1. **A separate gateway, `src/lib/vidiq-gateway/`.** It follows `wikipedia-gateway` and `social-gateway`: a barrel `index.ts`,
   one MCP client (`client.ts`) built on `@modelcontextprotocol/sdk`'s `Client` and `StreamableHTTPClientTransport`, the pinned
   contract (`contract.ts` plus the dated fixture), and an inventory test. The test fails when:
   - any file outside the gateway references `mcp.vidiq.com`;
   - any file outside the gateway imports `@modelcontextprotocol/sdk/client` (today no file in `src/` does);
   - any file outside the gateway imports a gateway child instead of the barrel;
   - any module other than `src/lib/vidiq-research/` imports the barrel. This pins the budget and cache (decisions 5 and 6) in
     front of every call.

   The server URL is a constant in the gateway, never a setting, so the key can only go to vidIQ. Tests inject a local URL
   through the gateway's dependencies. The gateway is not part of `youtube-read-gateway`: vidIQ is not a YouTube-family client
   (ADR 0007). It gets its own traffic counter, `vidiq_api` (`GatewayTrafficCategory`, §2.9k).

2. **An API key only.** YTM never starts vidIQ's OAuth or account sign-in. That sign-in grants vidIQ YouTube write scopes,
   which would be a YouTube writer outside `youtube-write-gateway` (ADR 0005) and outside `docs/WRITE_AUTHORIZATIONS.md`. The
   owner does not link our YouTube channels to vidIQ. Under a key, the allowlist below holds only tools that read; none writes
   to YouTube or to the vidIQ account. **This integration adds no YouTube writer,** so `docs/WRITE_AUTHORIZATIONS.md` does not
   change. Nothing here calls `write-context`, `youtube-write-gateway` or `assertLiveWritesAuthorized`, and a boundary test pins
   that.

3. **The key lives in the device-secrets store (ADR 0042) as a new slot, `vidiq`.** The other candidates do not fit:
   - `ai-connections` credentials hold an OpenAI-compatible provider's key, base URL and model for AI localization. That is a
     different domain, and its endpoint is configurable, which vidIQ's must not be.
   - The cloud-credentials transfer file is not a store. It only moves existing device secrets between computers.

   The slot gives `state`, `info`, `read` and `write` behind one key file, with a display hint (the last 4 characters), a status
   and a compare-and-set version. The same shape already holds the Gemini, ElevenLabs and Meta keys.

   Adding the slot changes no schema (`DEVICE_SECRET_NAMES` is code, and `device_secrets` is already device-local and never
   synced). The key is checked before it is saved, with the free `vidiq_balance`; a refused key is not stored
   (`vidiq_key_invalid`).

   The key is entered on the Mac only, the way the Meta app secret is (ADR 0068 §3): its route is in `src/proxy.ts`
   `REMOTE_BLOCKED_PREFIXES`. In Settings it is a `MaskedSecretInput`, never `type="password"`. Once saved, it never appears
   in a log, an error message or its `details`, an API response, MCP output, the ledger, the cache or browser code (AGENTS.md
   §F). A sentinel-key test checks every one of those surfaces. The spike's `~/.ytm-vidiq-key` file is temporary, not a
   product mechanism, and nothing reads it.

4. **A fail-closed allowlist of 18 tools**, each checked against the fixture, with its pinned cost:

   | Purpose | Tools (all prefixed `vidiq_`) | Cost |
   |---|---|---|
   | Niches | `keyword_research`, `channel_search`, `outliers`, `trending_videos`, `similar_channels` | 5 each |
   | | `trend_categories` | 0 |
   | Competitors | `channel_stats`, `channel_performance_trends`, `channel_videos`, `get_channels_by_ids`, `get_videos_by_ids`, `video_stats`, `video_change_history`, `title_thumbnail_wins`, `video_earnings_estimate` | 5 each |
   | | `comment_insights` (asynchronous) | 5 per discover, validate or new raw search; 0 for a raw page with `cursor` |
   | Utilities | `balance`, `job_poll` | 0 |

   Every other tool stays out, including the generation, media, voice, coach, bookmark, competitor-list, own-channel analytics
   (YTM has the Analytics API), TikTok, Instagram and upload tools.

   **The gateway refuses before sending anything** when:
   - the tool is not on the list (`vidiq_tool_not_allowed`);
   - the live `tools/list` lacks it, for example because it was renamed (`vidiq_tool_missing`);
   - our arguments fail either the pinned input schema or the live one, or the live schema requires a property the pinned one
     does not (`vidiq_schema_drift` or `vidiq_args_invalid`);
   - the cost stated in the live description cannot be read or differs from the pin (`vidiq_cost_changed`);
   - an allowlisted tool newly reports `readOnlyHint: false` (`vidiq_annotation_drift`). **The one documented exception** is
     `comment_insights`, which reports `readOnlyHint: false` and `idempotentHint: false` because it creates an asynchronous job
     on vidIQ's side. It reads indexed comments and writes nothing to YouTube.

   **Arguments are allowlisted too:**
   - Only the pinned schema's properties are accepted, and an unknown one is refused.
   - `userGoal` is never forwarded. It would carry an agent's context to a third party, and it would split the cache.
   - Channel and video arguments must be canonical ids: `UC` plus 22 characters, or 11 characters for a video. A handle or URL is
     refused, because the cache key and `watchlist.add` need ids.
   - `job_poll` accepts only an `mcpJobId` that our own ledger recorded.

   The live `tools/list` is free. It is read once per process and kept for an hour, and read again once before any drift
   refusal is returned.

5. **A credits ledger and a budget, owned by the feature module.**
   - **Ledger.** `src/lib/vidiq-research/` records every call in a device-local table: the time, the caller (`owner` or
     `producer`), the tool, a SHA-256 of the canonical arguments, the stated cost, `_credits.used`, the outcome
     (`ok | cache_hit | refused | failed | unknown | job_pending`), the job id and the balance afterwards.
   - **Budget.** A monthly budget setting defaults to 150, the Free tier.
   - **Preflight.** The check runs under one per-process lock, so two calls cannot both pass it. A call whose stated cost exceeds
     the budget left in the period (`vidiq_budget_exhausted`) is refused before anything is sent. So is a call that exceeds the
     last known account balance (`vidiq_insufficient_credits`). The balance is read again, free, when the stored snapshot is more
     than 10 minutes old.
   - **Account sync.** The balance snapshot is bound to the key, the shape of ElevenLabs' account limit (ADR 0057 amendment 1). It
     is read on key save, on the owner's «Обновить», before a paid call when stale, and after every paid call (the free
     `vidiq_balance`). There is no periodic read.
   - **Period.** vidIQ's own renewal cycle, ending at `renewableResetsAt` from the last balance, or the calendar month (UTC)
     until a balance is known.
   - **Refunds.** They follow vidIQ's own numbers: a result with `_credits.used: 0` costs 0, and an asynchronous job counts 0 once
     `job_poll` reports `refunded: true`.
   - **Uncertain outcomes.** A call whose outcome is unknown (timeout, connection lost after sending) counts at its stated cost.
     A paid call is never retried automatically.
   - **Overcharge.** A result whose `_credits.used` exceeds the pinned cost marks that tool drifted until the pin is reviewed.

6. **A cache with a TTL per tool and a hard 30-day cap.** The key is the tool plus normalized arguments (sorted keys, empty values
   and `userGoal` dropped), so a repeated question costs 0 credits.
   - **TTLs.** 24 h for the fast-moving searches (`keyword_research`, `channel_search`, `outliers`, `trending_videos`,
     `title_thumbnail_wins`, `comment_insights`). 7 days for channel and video facts, `similar_channels` and `trend_categories`.
     `balance` and `job_poll` are never cached; a finished job's result is stored under the call that started it.
   - **Concurrency.** Identical calls in flight share one request.
   - **Refresh.** `refresh: true` skips the cache and pays.
   - **Hard cap.** No row lives past 30 days, whatever its TTL. vidIQ's data about YouTube channels stays subject to YouTube's
     terms (vidIQ terms, third-party platforms), and YouTube's Developer Policies (III.E.4) allow other channels' data to be
     stored for 30 days. YTM already applies that limit (architecture §24, owner decision D1).
   - **Classification and storage.** The cache table is classified `non_authorized` in `src/lib/youtube-data-policy/` (clock
     column `fetched_at`), so the existing retention pass purges it and scrubs backups. It is device-local (not in the snapshot,
     not synced) and is never written to the research export, Market Intelligence's snapshots or `research_evidence`. Keeping it
     to the computer that fetched it also respects §5(t), which forbids redistributing.

7. **A feature module, `src/lib/vidiq-research/` (AGENTS.md §M).**
   - **Ownership.** It owns the tables, the services, the MCP tool handlers and the UI routes.
   - **Switch.** A Settings switch turns it off. The switch is off by default and can be on only while a key is saved; the first
     verified key save turns it on, and clearing the key turns it off.
   - **When off or failing.** Every vidIQ tool answers `vidiq_disabled` or its own error. Nothing else in YTM depends on it, and
     it runs no background work at all (`src/instrumentation.ts` starts nothing for it).
   - **Market Intelligence.** The module reaches it only through public cores, never its `db` symbols: the existing
     `producer_propose { kind: "watchlist.add" }`, which `agent-proposals` applies with Market Intelligence's `addToWatchlist`
     after the owner approves, and in stage 3 the owner's own add through the same public `addToWatchlist`.
     `agent_create_market_research_request` does not fit: it takes a search query and runs one `search.list` after approval,
     not a known channel id, and it is not on the Producer's list. Whether vidIQ finds should also become discovery candidates
     is an open question in the plan; Market Intelligence has no public method for external candidates today.

8. **The consumers.**
   - **Producer tools (stage 2).** Three Producer-only tools in YTM's own MCP server:
     - `producer_vidiq_tools` lists the allowlist with costs, pinned input schemas, TTLs and the drift state. It is free.
     - `producer_vidiq_call { tool, args, refresh?, maxCredits? }` goes through the cache, the budget and the gateway.
     - `producer_vidiq_balance` returns the balance, the budget, the period and the Producer's recent ledger. It is free.

     Every answer carries `creditsSpent`, the balance, the budget left, `cached`/`fetchedAt` and
     `source: "vidIQ (third-party estimate)"`, with vidIQ's result under `data`. The paid call needs a new Producer permission,
     `VIDIQ_RESEARCH`, named in `producer_get_capabilities`. That report's sentence "No tool here … spends money by itself" is
     amended to name vidIQ credits. Channel agents and the factory get no vidIQ tool. The Producer API version takes the next
     minor number (additive; 1.34.0 if nothing lands first).
   - **Settings card (stage 1),** in «Облачные API»: the key, the switch, the connection and drift status, the balance, the
     budget and the recent ledger.
   - **Research tab «vidIQ» sub-tab (stage 3).**
   - Every UI text is a key in `src/lib/ui-text/locales/*` in every language (AGENTS.md §H).

9. **The owner lifts Phase 9's limits for vidIQ, within bounds.** vidIQ's discovery tools and its earnings estimates
   (`vidiq_video_earnings_estimate`, and `vidiq_channel_search`'s `estimatedEarnings*` filters) cross the limits in
   `PHASE_9_PLAN.md` §4/§16 and `FUTURE_PHASES.md` §5. The owner's TG 4949/4953 changes them for this source only:
   - Discovery runs only on an explicit call by the owner or the Producer. There is no scheduled or automatic crawling.
   - Every vidIQ number is labelled a third-party estimate and kept apart from YTM's own observed data. It is never stored as a
     Market Intelligence snapshot or evidence row, and never fed into derived metrics.

   YTM itself draws no profitability conclusion. Stage 1 adds a dated note citing this ADR to both requirement documents.

10. **Why YTM proxies vidIQ instead of each agent connecting to it.** If each agent connected to vidIQ itself:
    - every agent would hold the key in its own configuration and context;
    - each would spend the one 150-credit allowance with no shared budget, so one agent's curiosity could leave nothing for the
      next;
    - the same question asked by two agents would be paid twice;
    - nothing would record who spent what;
    - nothing would stop an agent from calling a tool that sends a message to a human coach, generates media, edits the vidIQ
      account, or (signed in with OAuth) writes to YouTube.

    Behind YTM, the key stays in one encrypted store outside every agent's context. One budget and one cache serve the owner and
    every agent. Every call is in one ledger, the allowlist is enforced in code, and a change in vidIQ's tool list or terms is
    caught and handled in one place.

## Consequences

- **The contract can drift.** vidIQ's MCP server is versioned 1.0.0, is not a published REST contract, and can change under us.
  A changed tool, schema, annotation or price makes YTM refuse that tool until a developer refreshes the fixture and the pins
  (an announced change in a new dated fixture). Refusing is the intended behaviour.
- **The cap is small.** At about 30 research calls a month on Free, the cache and the budget are what keep it usable. The owner
  can upgrade without reconnecting, and only the budget setting changes.
- **vidIQ numbers are estimates.** No vidIQ figure becomes a YTM fact. Agents see the source label on every answer.
- **The key is per computer.** The key and the ledger live on the computer where the key was typed (the Mac). The account-wide
  balance still counts usage from vidIQ's own app and every other client, so the preflight's balance check covers them.
- **Results are untrusted.** vidIQ's results carry text written for the agent ("follow and relay them"). YTM passes them as
  `data` under a source label with a size cap, and never as instructions. A RISK entry records this in stage 2.

## Compatibility / migration impact

- **Stage 1** adds the device-secret slot (no schema change) and one device-local ledger table, which is additive and takes
  the next free schema version (127 today).
- **Stage 2** adds the device-local cache table, classified `non_authorized`, and additive Producer tools (a minor Producer API
  version).
- **Stage 3** changes no schema.

Nothing existing changes meaning, and no YouTube writer, MCP tool or channel-agent contract is altered. Removing the module
drops two device-local tables and a key slot.

## Alternatives considered

- **A child of `youtube-read-gateway`.** Rejected: vidIQ is not a YouTube-family client (ADR 0007), and its key, budget and terms
  differ.
- **OAuth sign-in.** Rejected: it grants YouTube write scopes outside ADR 0005.
- **Agents connect to vidIQ directly.** Rejected for the reasons in decision 10.
- **One Producer tool per vidIQ tool.** Rejected: it would tie YTM's MCP contract to vidIQ's argument lists. The generic call
  checks arguments against the pinned and live schemas instead, and `producer_vidiq_tools` publishes them.
