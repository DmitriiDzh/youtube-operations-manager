# The interface always says what is happening now (BL-195)

**Status: planned 2026-10-17, branch `feature/ui-feedback-clarity` (one feature, one branch, owner msg 2935).**
Owner, Telegram 2026-10-17: the review screen's loading window (msg 2916, merged in 1b1ffa44); the request to find other places
for it, or better alternatives (msg 2930): "the user always understands what is happening now, and the interface is crystal
clear". The analysis was sent as msgs 2933/2934 and accepted with its order (msg 2935).

## 1. Findings (the code as of `43a98a03`/`1b1ffa44`)

- Four ways of waiting exist side by side:
  1. `operation-progress/OperationOverlay` + `useOperation` (blur, stage, X / Y, elapsed time, Cancel, a final Close). 12 panels
     use it for YouTube writes and syncs.
  2. `LoadingOverlay`: app start and channel switch.
  3. `LoadingIndicator` ("Loading…" text) while a tab's data loads.
  4. A local `busy` flag that only disables buttons, in about 55 components. About half show nothing else: no spinner and no
     "Saving…" text.
- The review screen's new window (1b1ffa44) uses `BlockingDialog` directly, beside `OperationOverlay`: a second, hand-made
  blocking pattern.
- Success and error messages are worded and kept differently on each screen.
- Long work (pods, Gemini jobs, uploads, the live stream, device sync) shows its state only on its own tab, so from any other tab
  the owner cannot see what runs.

## 2. Rules (what each kind of action shows)

| Action | Feedback |
|---|---|
| Under 300 ms | nothing new (no flicker) |
| 0.3–15 s, changes what is on screen next, spends money or writes to YouTube | blurred screen + a centred window with what is being done; keys and clicks blocked; once shown it stays at least 500 ms |
| 0.3–15 s, local and safe | the button itself: spinner + "Saving…"-style text, then "✓" for 2 s |
| Minutes (pods, generations, uploads, a stream, sync) | never blocks: the action's request is short (above), then the work is listed in the Activity centre |
| Success | a short message that hides itself after 4 s |
| Error | stays until closed (× button), with what failed in words |

## 3. Design

### Stage A: one shared feedback module, `src/components/busy-feedback/`

The one owner of "show that something is happening" for short actions (AGENTS.md §M shared logic); `operation-progress` stays
the owner of long, tracked operations and is not changed.

- `useBusyAction()` → `{ run(label, action), hold(label), release(), busy, overlay }`:
  - `run` sets the window's text, waits 300 ms before showing it, and keeps it at least 500 ms once shown; the action's result
    and errors reach the caller unchanged.
  - `hold`/`release`: a wait that is not a request (the review screen's "until the next track's waveform is ready").
  - A held wait has a 20 s cap (the review screen's existing cap).
- `<BusyOverlay state>`: `BlockingDialog` + a large `Spinner` + the text. While shown it swallows every key in the capture phase
  (as `OperationOverlay` does), so no screen shortcut runs behind it.
- `<ActionButton busy busyLabel done>`: a button that shows a spinner and its busy text while `busy`, and "✓" for 2 s after
  `done` changes; disabled while busy.
- `<StatusNotice>` + `useNotice()`: one message line; `ok` hides after 4 s, `error` stays with a × button.
- Pure timing/state logic in `busy-state.ts`, unit-tested from the rules in §2 (expected times stated by hand).

### Stage B: the review screens on the shared module

- `plan-review-screen.tsx`: its own window (1b1ffa44) is replaced by `useBusyAction` (`run` for verdicts, re-check answers,
  picks, "none fits"; `hold` until the next track is ready). Behaviour stays the same plus the 300/500 ms rule.
- `storyboard-review-screen.tsx`: approve, request changes, reply/comment, version switch → the window.
- `storyboard-renders.tsx`: the render verdict → the window.

### Stage C: the window for risky or money actions

- `live-stream-panel.tsx`: start, stop, restart, go live.
- `device-sync-divergence-card.tsx`: the divergence choice.
- `media-generation-settings.tsx`: start / stop a session (pods), the network-volume actions that cost money.
- `gemini-media-create.tsx`: create a paid job.
- `publishing-packages.tsx` / `publishing-new-package.tsx`: queue an upload, approve / save a package.
Each gets a window text of its own ("Starting the stream…", "Renting the pod…").

### Stage D: the Activity centre

- A new read-only server summary module `src/lib/activity-summary/` and route `GET /api/activity` (session required; the active
  channel resolved server-side, ADR 0004 (b)). It reads, each in its own try/catch so one source failing never breaks the others
  (§M):
  - running server operations (the operations registry);
  - active media jobs of every computer (`media-jobs-pool`, BL-188), RunPod and Gemini;
  - uploads queued or running (publishing);
  - the live stream's state;
  - device sync busy / waiting.
  Codes and counts only: no prompt, path, key or token.
- `activity-indicator.tsx` in the header, beside the sync bell: a ring + the number of running things (hidden at 0); a click
  opens a list grouped by kind, each row with its state, elapsed time and a link to its tab. Polled every 5 s while the window is
  visible.

### Stage E: loading placeholders and one message style

- `Skeleton` rows instead of "Loading…" in the big lists: Content's video list, the review queue, the publishing calendar.
- The panels touched in stages B–C use `StatusNotice`.

## 4. Acceptance

- AC-FB-01: an action under 300 ms shows no window; one of 1 s shows it from 300 ms to 1 s; one of 350 ms shows it 300–800 ms.
- AC-FB-02: while the window is shown, keys and clicks reach nothing behind it; it closes by itself (no Close button).
- AC-FB-03: a `hold` closes on `release` or after 20 s, whichever comes first.
- AC-FB-04: an `ActionButton` shows the spinner + busy text while busy and "✓" for 2 s after success.
- AC-FB-05: an `ok` notice hides after 4 s; an `error` notice stays until ×.
- AC-FB-06: the review screen behaves as in 1b1ffa44 (window while saving and until the next track is ready, the wave-done window)
  on the shared module; no second blocking component remains in it.
- AC-FB-07: every action in stages B and C shows its own window text; double clicks start nothing twice.
- AC-FB-08: `/api/activity` → 401 without a session; with one, each source's failure leaves the others listed and marks that
  source `unavailable`; no secret or path in the answer.
- AC-FB-09: the header indicator shows the count of running things, hides at 0, and lists them with links.
- AC-FB-10: every new text in English and Russian (`ui-text` tests).

## 5. Out of scope

- `OperationOverlay` itself (long tracked operations) is unchanged.
- Settings toggles that already show "Saved" keep their own line.
- No new write path, no YouTube call, no schema change.
