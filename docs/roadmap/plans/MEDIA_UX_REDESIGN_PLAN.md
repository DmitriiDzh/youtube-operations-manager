# Media section UX redesign: Plans, Review, Jobs (plan)

**Status: APPROVED, implemented on the branch, review pending (BL-162).** Owner, Telegram 2026-10-09 (msg 2244): concept accepted, FO-REQ-0013 in the same
branch, built directly in the app (no prototype). Branch: `feature/media-ux-redesign`, one merge approval at the end.

**Source.** Owner, Telegram 2026-10-09 (msg 2232): "Оцени как выглядит раздел media и экраны проверки треков. Действуй как
профессиональный UI/UX дизайнер… переработать UI этого раздела, чтобы работа с ним была интуитивно понятной и удобной."
The audit and the concept went to the owner on 2026-10-09 (msgs 2236–2242). Related: FO-REQ-0013 (see §5).

**Scope.** Slices 1–3 are UI-only: `plan-review-screen.tsx`, `generation-plans-panel.tsx` and the Media → Jobs card
(`JobsCard` in `media-generation-settings.tsx`), plus an optional `?wave=` on the review route (AC-UX-09). Slice 4
(FO-REQ-0013) changes the generation-plans sync report to version 3, adds a peer route and a table (§5).

## 1. Audit (2026-10-09, live screens, plan R-0001-S1-music)

The user's job on the review screen is to **listen to a track and decide**. The screen does not put that job first.

| # | Screen | Finding |
|---|---|---|
| 1 | Review | Three `ToggleSwitch`es (loudness match, spectrogram, blind) show no visible text. The component is `aria-label`-only by design, and the call sites add no caption. |
| 2 | Review | The heading joins the channel, "Review", the plan id and the full wave title, and wraps to two lines. |
| 3 | Review | The wave picker is a wall of long titles with statistics inside each chip. |
| 4 | Review | The chosen wave's card prints every prompt and lyric in full, which pushes the player to about y≈700. |
| 5 | Review | The track line shows the job UUID. "ждут: 164 · в очереди: 203" is two numbers with no explanation. |
| 6 | Review | The decision comes last (reasons → rating → comment → mark → buttons). It is not pinned, so the user scrolls past the player to decide. |
| 7 | Review | Validator results are a flat list, so a failed check is hidden among the passed ones. |
| 8 | Plans | Waves are listed oldest first, so the current work is at the bottom. |
| 9 | Plans | "Добавить заметку к этой волне" repeats on every wave. Zero counts are coloured green and red. |
| 10 | Plans | Waves have no "Проверить (N)" of their own. |
| 11 | Plans | The "Слушать и отбракованные" switch has no visible text either. |
| 12 | Plans | "Отменить план" sits beside the primary action as an equal button. |
| 13 | Plans | The review bar reads 29/292, while the real remainder (164) is shown somewhere else. |
| 14 | Jobs | The hint still points to a "Сессии" tab, which moved to Servers in BL-157. |
| 15 | Jobs | Rows show UUIDs, not the plan or wave. Plan attempts imported from the factory are not app jobs, so 8 rows next to 290 generated tracks is correct but confusing. |
| 16 | Jobs | Exchange cleanup, including a red "delete leftovers" button, sits in the daily work view. |

## 2. Design

### 2.1 Review screen (as built after the owner's rounds, msgs 2254, 2263, 2269, 2276)

The first build (three stacked zones and a pinned verdict bar) was judged "much empty space, untidy" (msg 2263), so the
structure itself was changed:

- **One toolbar.** Back, the channel and plan, the wave picker (a dropdown: waves with tracks waiting, then the reviewed
  ones), "reviewed N of M", the validator filter, "About the wave" (a popover with the notes, params, prompt and lyrics) and
  "View" (a popover with the three captioned switches; blind mode is called "Hide the auto-check until my verdict").
- **Three columns, window-high, each scrolling on its own.** From left to right:
  - the player (160 px waveform, a round play button, A/B in the transport row) with the verdict right under it;
  - the auto-check;
  - the queue (msg 2276: on the right).
- **The verdict.** Calm tinted "✓ Accept [A]" / "✗ Reject [R]", the 1–10 rating, the reasons with icons, a three-line
  comment, the mark, and "↻ Ask to generate again" with an explanation.
- **The auto-check.** Every check is visible: a ✓/✗ mark, the value and the limit. The failed ones come first, highlighted,
  with a jump to their time. There are no folded lists (msg 2254).
- **The queue.** Groups "Waiting for your verdict · N" and "Reviewed · N". Each track shows its name, seed, "auto-check ✓/✗"
  (hidden in blind mode), and the verdict with its rating or "on <computer>".
- **Removed (owner, msg 2263):** "Take this wave" and "show claimed ones too". What is in work follows what is open (§5.4).
  This supersedes BL-157 AC-WV-06 (manual wave claim) and the AC-TC-02 switch. A claimed track still opens from the queue.

### 2.2 Plan card (as built, msgs 2263, 2271)

- **Header.** The title, one line of facts, and the description folded to one line with "more". Then the primary
  "Review (N)" and a "⋯" menu (Complete, Cancel; confirmed as before).
- **KPI tiles.** Waiting for you (clickable), Accepted, Generated, Spend, Time left. Budget and review notices colour the
  tiles instead of being badges.
- **The stages** form one funnel line.
- **The "Listen to rejected tracks too" switch** has its caption.
- **The waves** form a table: Wave | Recipe | Generated | ✓ | ✗ | Waiting | Review. Rows are newest first and the Review
  buttons are equal width. The factory and owner notes open on the row's arrow. Waves with nothing waiting, except the
  newest, are folded.
- **Media's accent is violet:** `ToggleSwitch tone="violet"` and the buttons. Red stays the default switch for settings.

### 2.3 Jobs

- Each row shows the plan, the item and the seed when `job.plan` is set. UUIDs are shortened and get a copy button.
- The stale hint links to Servers → Sessions.
- The exchange cleanup moves to Servers → Setup. It is device-wide maintenance, not channel work.

## 3. Preserved (must not change)

- Every MEDIA_REVIEW_TOOLS.md §2 group A tool, plus the msg 1939 additions:
  - rating out of 10, comment and mark at playhead;
  - blind mode (off by default) and ask for a re-run;
  - `atSeconds` markers and the R-0001 reason list (`REVIEW_REASONS` values unchanged).
- Phase 3: loudness match (on by default), spectrogram, A/B with the nearest references, frequency marks.
- The keyboard map (`reviewKeyAction`), auto-advance, track claims (wave claims from older builds are still honoured; taking a
  wave by hand was removed by the owner, §2.1), "Replace?" (`plan_verdict_exists`), the verdict history and the peer-device
  paths.
- The routes `/media/plans`, `/media/jobs` and `/media/plans/<id>/review` (BL-149 AC-RT-07).
- The conventions `ToggleSwitch`, `ConfirmDialog` and no native dialogs, and every label in `en` and `ru` (AGENTS.md §H).
- The exported helpers the existing tests import keep their behaviour. A changed expectation needs a stated requirement
  (AGENTS.md §L).

## 4. Acceptance criteria (defined before implementation)

- **AC-UX-01** Every switch in Media (plan card, review) has visible caption text next to it, with a key in `en` and `ru`.
- **AC-UX-02** At a 1280×800 viewport, Accept, Reject, the waveform and the play control are visible without scrolling. The
  verdict sits right under the player, and the screen is exactly window-high.
- **AC-UX-03** Wave context (prompt, lyrics, differing params) is collapsed by default, and one control expands it.
- **AC-UX-04** The review heading is one line: plan, wave short label, waiting / total. The full wave title is reachable
  through the expanded context or a tooltip.
- **AC-UX-05** The track line shows the item key and the seed. The attempt reference is not shown in full by default and can
  be copied.
- **AC-UX-06** A validator-rejected track lists its failed checks before any passed check. Passed checks are collapsed with
  their count.
- **AC-UX-07** The wave picker lists the waves with waiting tracks first. Fully reviewed waves follow under "Reviewed".
- **AC-UX-08** The plan card has exactly one primary button. Complete and Cancel are reachable through a menu and still
  confirm through `ConfirmDialog`.
- **AC-UX-09** A wave with N > 0 waiting has "Проверить (N)". It opens `/media/plans/<id>/review?wave=<groupId>` with that
  wave chosen and its first waiting, unclaimed track on screen. Without `?wave=` the screen behaves as today.
- **AC-UX-10** Plan-card waves are listed newest first. A wave with zero waiting, zero accepted and zero rejected shows no
  coloured counts.
- **AC-UX-11** Jobs: a job linked to a plan shows the plan id and the item key. The empty-session hint names Servers →
  Sessions. The janitor buttons are in Servers → Setup and no longer in Media → Jobs.
- **AC-UX-12** The keyboard map and verdict payloads are unchanged. The existing
  `plan-review-screen.test.ts` / `generation-plans-panel.test.ts` pass unchanged.

- **AC-UX-15** The queue lists the walk's tracks in two groups, waiting and reviewed. Each track has its state and a click
  opens it. The open track stays in view.
- **AC-UX-16** Scrollbars are dark and thin everywhere (`src/app/ui-kit.css`). The Media switches use `tone="violet"`.

## 5. FO-REQ-0013: the same plan on every computer (slice 4)

Reply to the Factory Operator: DEV-RESP-0015. What already works for another computer's plan: playing tracks and references,
A/B, verdicts (applied on the owner's tick), track and wave claims, and the wave list and context.

### 5.1 One plan list and one card

- Media → Plans lists this device's plans and the other devices' plans of the active channel in one list. The `/peers` route
  already filters to the active channel. A small label names the device and the report's age, plus "stale" after 5 min.
- A peer plan opens the same `PlanDetailCard`, built from the report by a defensive adapter (`peerPlanToDetail`). `progress` is
  a loose record that is shown and never recomputed, and the adapter must tolerate a version 1 report.
- Actions that change the plan stay on the owning device: Complete, Cancel, the review-rejected switch and "Ask for a re-run".
  They are shown disabled with "на <computer>", never hidden.

### 5.2 Wave note from another computer (report version 3)

- **Sender.** `POST /api/generation-plans/peers/<deviceId>/<planId>/group-note` `{ groupId, note|null }` stores an outgoing
  note `{ noteId, planId, ownerDeviceId, groupId, note, at }` in a new table. It is kept 30 days, like outgoing verdicts. The
  call is refused when:
  - the plan is not active or is not on the active channel;
  - the group is unknown;
  - the owner's report version is below 3 (`peer_update_required`).
- **Report v3.** A new optional `groupNotes` field carries the newest outgoing note per (owner, plan, group), at most 200. Each
  shared group gets an optional `ownerNoteAt`: the time of its current owner note, derived from the plan's `group_note`
  events. The new build writes version 3 and reads 1–3. A version 2 build refuses it with "update the app", as v2 did to v1.
- **Owner's tick** (next to `applyPeerVerdicts`). A note for this device's active plan and a known group is handled as
  follows:
  - Skip it when its `noteId` is already in a `group_note` event, or when it is dated more than 5 min in the future.
  - Compare it with the group's last change, which is the newest `group_note` event's `details.writtenAt ?? at`:
    - if it is newer, apply it: set `ownerNote` and record `group_note` `{ groupId, note, noteId, fromDevice, writtenAt }`;
    - otherwise record `group_note` `{ …, superseded: true }` and leave `ownerNote` unchanged.
- **Sender's view.** "sent, waiting for <computer>" while the owner's `ownerNoteAt` is older than the outgoing note's `at`.
  - When it equals the note's `at`, the note was applied.
  - When it is newer, the owner's note is shown and the outgoing one is no longer pending.

### 5.3 Acceptance criteria (hand-computed, §L)

- **AC-NOTE-01** Peer note written 10:05. The owner's last change was at 10:00 by the owner's own edit. Result: applied,
  `ownerNote` = the peer text, and one `group_note` event with `fromDevice` and `writtenAt` 10:05.
- **AC-NOTE-02** Peer note written 10:05. The owner edited at 10:10. Result: not applied, `ownerNote` keeps the 10:10 text, and
  the event is recorded `superseded: true`.
- **AC-NOTE-03** Two peers wrote A at 10:00 and B at 10:05:
  - both arrive in one tick: B is the result;
  - B is applied first and A arrives in a later tick: B stays, and A is superseded.
- **AC-NOTE-04** Delayed delivery. A (10:00) is applied at 10:20, then B (written 10:05) arrives at 10:30. Result: B is applied,
  because the comparison uses the time the note was written, not the time it was applied.
- **AC-NOTE-05** The same `noteId` delivered twice changes nothing the second time and adds no second event.
- **AC-NOTE-06** A note for a closed plan, an unknown plan, an unknown group or another device's plan is skipped, and nothing
  is written.
- **AC-NOTE-07** `note: null` clears the owner note under the same rules.
- **AC-NOTE-08** The sender refuses with `peer_update_required` when the owner's report version is 1 or 2, and stores nothing.
- **AC-NOTE-09** A version 3 report with `groupNotes` and `ownerNoteAt` parses on the new build. Versions 1 and 2 still parse.
  A version 3 report is refused by a schema that knows only 1–2. That last point is checked against the old schema's
  literal, not run.
- **AC-UX-13** For a peer plan, Complete and Cancel (in the menu), the review-rejected switch and "Ask for a re-run" render
  disabled with "на <computer>".
- **AC-UX-14** The Plans list shows this device's plans and the peers' plans of the active channel in one list, each with its
  device label, and each opens the same card.

### 5.4 What is open, in seconds (owner msgs 2254 p.5, 2259, 2263)

- **The presence file.** Each device writes its live claims to `<sync folder>/generation-plans/global/<deviceId>.presence.json`
  (`ytm-review-presence` v1, strict) whenever a claim changes.
- **Reading it.** The others read it straight from disk. For a device that has one, it replaces that device's report claims.
- **Timing.** A claim lives 90 s, the screen renews it every 30 s, and `GET …/claim` is polled every 3 s.
- **Same track opened twice.** When both computers opened one track within the delay, the earlier opener keeps it. The
  later one moves on automatically, but only with an untouched draft.
- **Syncthing.** Set the shared folder's watch delay to 1 s.
- **AC-PR-01** A claim reaches the owning device without a report.
- **AC-PR-02** A release is gone at once, even while the older report still names the claim.
- **AC-PR-03** A device without a presence file is heard through its report.
- **AC-PR-04** A malformed, oversized or impersonating file is ignored.
- **AC-PR-05** The quick read answers only for the active channel's plan.

## 6. Slices (one branch, one merge approval)

1. Review screen (AC-UX-01..07, 09 review side, 12).
2. Plan card (AC-UX-01, 08..10).
3. Jobs (AC-UX-11).
4. FO-REQ-0013: one list and one card (AC-UX-13/14), then the wave note relay and report v3 (AC-NOTE-01..09).
5. Owner review rounds (msgs 2254–2276): the three-column review, the KPI card, the UI kit, the presence files (§5.4).

## 7. Owner answers (msg 2244)

1. The concept is accepted. The waveform draws on the owner's machine, so the audit's "Загрузка волны…" was an automation
   artefact.
2. FO-REQ-0013 goes in the same branch.
3. No prototype: build it directly in the app.
