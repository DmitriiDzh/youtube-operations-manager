# Servers → «Аналитика»: generation history and spend (BL-219)

- **Request:** owner, Telegram msg 3411 (2026-10-24): «в разделе серверов иметь возможность видеть аналитику по нашим генерациям и
  тратам … историю генераций, расходы и на что было потрачено. Инфографику». As a UI/UX designer.
- **Design:** mockup sent in msgs 3413/3414 (real 30-day data). Owner msg 3415: a) a separate tab — yes; b) every computer summed —
  yes; c) nothing to add for now.

## What exists (reused, not rebuilt)

- `src/lib/video-costs` (ADR 0041) already turns every RunPod job and Gemini job of every computer into one row with its USD
  (`SharedCostRun`: channel, video, template/model label, media kind, plan, status, usd, overhead, GPU seconds, times). This computer
  reads its own rows in full; the other computers come from their synced `video-costs` reports (unlinked runs kept 90 days,
  a published video's runs 120 days).
- This computer's `media_sessions` / `media_jobs` / `gemini_media_jobs` add what a report does not carry: the GPU type, who started
  it, a failed start, the session a job ran in, the outputs.

## Module and surface

- `src/lib/spend-analytics` (own module, AGENTS.md §M): pure aggregation over video-costs' runs plus this computer's session and job
  facts. Servers keeps working if it fails (the tab is its own error boundary; nothing else imports it).
- `GET /api/servers/analytics?days=7|30|90|all&channelId=&device=all|this&who=all|owner|factory|agent&tz=` → summary.
- `GET /api/servers/analytics/history?…same filters…&kind=all|runpod|gemini&errors=1&cursor=` → the unified history, 30 per page.
- `GET /api/servers/analytics/preview?source=runpod|gemini&jobId=&index=` → a small JPEG of this computer's image output.
- Servers tab `analytics` (`/servers/analytics`), texts in every UI language.

## Acceptance criteria (written before the code)

- **AC-SA-01** Total = RunPod + Gemini over the period; RunPod = the sum of RunPod runs (job shares and sessions without jobs),
  Gemini = the sum of Gemini runs. Runs of every computer count once (the same run id from two reports is one run).
- **AC-SA-02** Results = finished (`done`) job runs; errors = `failed` or `cancelled` job runs; a session without jobs is neither.
- **AC-SA-03** Losses: idle/start = the overhead of job runs + every session without jobs that did not fail to start; failed
  jobs = the usd of failed or cancelled RunPod jobs; failed Gemini = the usd of failed Gemini jobs; failed starts = the usd of this computer's
  sessions that ended `failed` without a job.
- **AC-SA-04** Daily series: one bucket per day of the period in the viewer's time zone (`tz`), each split into RunPod work
  (usd − overhead), RunPod idle (overhead + sessions without jobs) and Gemini; days without spend are zeros.
- **AC-SA-05** Breakdowns, largest first: by template/model label (with run counts), by video (unlinked separately), by channel,
  by who (this computer only; the others' runs are «другой компьютер»), by GPU type (this computer's sessions).
- **AC-SA-06** Filters narrow everything: channel, period (by run creation time), device (this computer only), who.
  The previous period of the same length is returned for the total's change.
- **AC-SA-07** History: newest first. This computer's sessions are one row each with their jobs inside (each with its usd) and the
  idle remainder; Gemini jobs and the other computers' runs are a row each. A failed start shows its error code. Paged by a cursor.
- **AC-SA-08** Read-only: no call to RunPod, Gemini or YouTube, and no write anywhere. Signed-in owner only (401 otherwise).
- **AC-SA-09** Previews: only this computer's image outputs, resolved inside the channel workspace's `From YTM` job folder (the
  existing resolver); anything else 404.

## Built (notes)

- `video-costs` gained `allRuns()` (every computer, this computer's runs in full) and a fix: a RunPod output's media kind follows its
  file name first (ComfyUI's video savers list an `.mp4` under `images`, so LTX clips were counted as images).
- The history groups a session's jobs by template / model (one line each: count, failures, average GPU seconds, sum, previews);
  the chart's day click narrows the history on the server (`day=`).
- Checked by eye on a copy of the real data (30 days: $28.03 = GPU $18.30 + Gemini $9.73, 1192 results) through an isolated dev
  server (`NODE_TEST_CONTEXT=1`, temporary preview page, removed); previews need the real signed-in app.
