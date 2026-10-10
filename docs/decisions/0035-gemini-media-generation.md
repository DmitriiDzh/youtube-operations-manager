# 0035. Images and video through Google's Gemini API, driven by the Factory Operator within the owner's limits

Status: Accepted

**Date:** 2026-10-10. **Decided** by the owner (Telegram, 2026-10-10, msg 2525, verbatim: «Проведи исследования как можно интегрировать
в нашу систему и выдать контроль оператору через mcp. Составь план и приступай к реализации. Как всегда по нашим правилам сделай эту
интеграцию отдельным модулем.»), after the research in msg 2524. Plan: `docs/roadmap/plans/GEMINI_MEDIA_PLAN.md` (BL-174).

## Context

RunPod generation (ADR 0023/0025/0026) rents a GPU pod for minutes. Google's Gemini API makes images (Nano Banana) and short video
(Veo 3.1) as a hosted service: no server, one paid call per result, from USD 0.034 per image and USD 0.05 per video second. The Factory
Operator should be able to use it over MCP, and the owner must keep control of the money.

## Decision

1. **A separate module, `src/lib/gemini-media/`** (AGENTS.md §M): key, settings, jobs, worker, files. It depends on shared modules
   (media gateway, workspace exchange, asset catalog, device key file, crypto, money) and on neither `media-generation` nor
   `generation-plans`; neither depends on it (a boundary test). Off, or without a key, it makes no network call.
2. **One gateway child, `src/lib/media-gateway/gemini-api.ts`** (single gateway per API category): the only code that reaches
   `generativelanguage.googleapis.com`; it checks the existing "Media gateway" toggle and counts `gemini_api` traffic. The key is sent
   only in `x-goog-api-key` and only to that host; a download redirect elsewhere is followed without it. Images use the Interactions
   API with `store: false`; video uses `predictLongRunning` and its operation.
3. **The key** is entered in Settings → Gemini, checked with Google before it is stored, kept AES-256-GCM-encrypted under this device's
   own key file `gemini-media.key` (the key-file logic moved to the shared `src/lib/device-key-file/`), and shown only by its last 4
   characters. No MCP tool sets or reads it.
4. **Money.** The owner's switch is off by default. Limits per job, day and month (USD) and per number of active jobs; spend = the cost
   of finished jobs plus the estimate of active ones, this computer's local day and month. Estimates and costs come from the official
   price table in code (dated) and, for images, Google's own token counts. A request that was sent and then lost (timeout, restart
   mid-call, video never collected) counts at its estimate; one Google provably never received, or refused, counts 0.
5. **The operator** gets three tools (Factory API 1.12.0): `factory_gemini_get_status` (READ), `factory_gemini_create_job` (WRITE,
   device mutation gate first; a dry-run is a read) and `factory_gemini_get_job` (READ). Inside the limits a job runs without a click
   (as ADR 0026 does for GPU sessions); over a limit it is refused, naming the limit. A `requestId` makes a retry safe.
6. **Outputs** land in the channel's `99 Data Exchange/From YTM/gemini/<jobId>/` with a `manifest.json` (`ytm.gemini-job-manifest`
   v1) written last, and are registered as `generated_image` / `generated_video` assets. Inputs come only from the channel's
   `Sent to YTM`, read once with an identity check and re-checked by hash before sending.

## Consequences

- The operator can spend real money without a click, bounded by the owner's limits (TECHNICAL_DEBT RISK-109, RISK-123).
- The limits are per computer; the account-wide guard is the monthly spend cap in Google AI Studio.
- Prices are code constants: a Google price change needs a code change; costs are estimates, not Google's bill.
- The Veo models are previews; Gemini Omni Flash, the Batch API, Veo extension and plan integration are later items.
- Countries: the Gemini API does not serve Russia or Belarus; the account and billing must be in a supported country.
