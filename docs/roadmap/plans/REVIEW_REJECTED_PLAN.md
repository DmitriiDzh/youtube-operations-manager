# Owner review of validator-rejected tracks (BL-153, FO-REQ-0008)

**Requested** by the Factory Operator on the owner's behalf in FO-REQ-0008 (2026-10-08). **Assigned** by the owner in Telegram on
2026-10-08 (msg 2060). The owner paused the next music wave (R-0001 C14) until this is live.

## How it works today (answers to FO-REQ-0008's questions)

- The review queue holds only attempts that **passed** the stage right before `owner_review`: `accepted`/`done` at an external
  stage, or a finished job when that stage is in-app (`progress.ts` `derive`, `services.ts` `reviewEntries`). Validator-rejected
  attempts never reach it. There is no setting for it.
- An attempt with **no** row at that stage is not in the queue either. This change does not touch that.
- The owner's verdict already wins: an attempt counts as accepted when the final stage (`owner_review`) accepted it, even if an
  earlier stage rejected it. `recordOwnerVerdict` accepts a verdict on any attempt the plan has. So point 4 needs only the queue
  and the event flag.

## Design

- **The option** is plan-level: `reviewRejected: boolean` (default `false`) in the plan definition. The factory sets it in
  `factory_plan_create` / `factory_plan_import` / `factory_plan_update`. The owner can switch it on the plan card in
  Production → Plans. Plans without it behave exactly as today.
- **Which rejected attempts wait.** An attempt whose row at the stage right before `owner_review` is `rejected` and that can be
  played (an `auditionFile`, or a job of this plan), with no owner verdict yet.
- **What does not change.** A rejected attempt still does not count as "may still become accepted". The factory keeps
  generating until the target is reached, and an owner accept later counts on top. The validator row stays as it is.

## Acceptance criteria (written before the code)

- **AC-RR-01 option.** `reviewRejected` is accepted by create, import and update, kept in the definition, and returned with the
  plan. The owner's switch on the plan card updates it and records a `plan_updated` event with actor `owner`.
- **AC-RR-02 queue.** With the option on, a rejected and playable attempt with no owner verdict is in the review queue,
  `waitingReview`, `todo.waitingReview` and the `review_waiting` notice. Without the option, all of these are exactly as before,
  including on a plan that has rejected attempts. A rejected attempt that can't be played and a `failed` row never wait.
- **AC-RR-03 split counts.**
  - Each waiting entry and each `todo.waitingReview` entry says `validator: "passed" | "rejected"`.
  - The `review_waiting` notice carries `passed` and `rejected` next to `count`.
  - `GET /api/generation-plans/summary` returns `waitingPassed` and `waitingRejected` next to `waitingReview`.
- **AC-RR-04 owner verdict wins.** An owner `accepted` on a validator-rejected attempt counts toward the item's target and the
  plan progress. Its `owner_verdict` event carries `overridesValidator: true`. Its other events do not.
- **AC-RR-05 order.**
  - Waiting entries come before reviewed ones, as now.
  - Among waiting rejected entries, fewer failed `fail`-severity checks come first.
  - Ties follow the plan's item order, then the attempt.
- **AC-RR-06 review screen filter.**
  - "All / Validator passed / Validator rejected", each with its count.
  - The keyboard shortcuts work inside the filtered list.
  - Next/previous stays within the filter.
- **AC-RR-07 failed checks first.** A rejected entry shows one line at the top of its failed checks.
  - Order: `severity: fail` first, then `warn`.
  - Each check shows its label, its value against the threshold, and its `atSeconds` region.
  - Each check shows how far over the threshold it is (a percentage of the threshold), so near-misses stand out.
  - The waveform markers and spectrogram marks are unchanged.
- **AC-RR-08 plan complete.** With the option on, a plan is complete only when no rejected attempt waits either.
- **Contract.** Factory API 1.6.0 (additive). The channel-agent plan read tools show the new notice fields. MCP/API texts stay
  English.

## Slices (one branch `feature/review-rejected`)

1. Module: option, queue, counts, order, `overridesValidator`, Factory API 1.6.0 and its tests (AC-01..05, 08).
2. Web UI: plan-card switch, split badge text, review-screen filter and the failed-checks line, with keys in every language
   (AC-01, 03, 06, 07).
3. Docs, then a release note to the Factory Operator.

Other devices' plans (phase 2) are computed on the device that owns the plan, so both computers need this version before a
rejected track of a plan owned by the other computer appears in its queue.
