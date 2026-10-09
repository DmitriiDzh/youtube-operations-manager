# Media section UX redesign: Plans, Review, Jobs (plan)

**Status: DRAFT. Waiting for the owner's answer to the concept.** Branch: `feature/media-ux-redesign`.

**Source.** Owner, Telegram 2026-10-09 (msg 2232): "Оцени как выглядит раздел media и экраны проверки треков. Действуй как
профессиональный UI/UX дизайнер… переработать UI этого раздела, чтобы работа с ним была интуитивно понятной и удобной."
The audit and the concept went to the owner on 2026-10-09 (msgs 2236–2242). Related: FO-REQ-0013 (see §5).

**Scope.** This is a UI-only change to `plan-review-screen.tsx`, `generation-plans-panel.tsx` and the Media → Jobs card
(`JobsCard` in `media-generation-settings.tsx`). It changes no API, schema, MCP contract or sync behaviour. The one exception
is a new optional `?wave=` on the review route (AC-UX-09).

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

### 2.1 Review screen: three zones

1. **Context bar** (one line): `‹ План R-0001 · C14 · ждут 37 из 40`, the previous and next arrows, and "Назад к плану". The full
   wave context (factory note, owner note, templates, differing params, prompt and lyrics) opens with a "О волне" button and
   is collapsed by default.
2. **Player** (full width, dominant): the waveform, transport, time and A/B in one row. Under it sits a labelled "Вид" group
   with visible captions: loudness match, spectrogram, blind. Loudness and claim lines become small captions.
3. **Verdict bar** (sticky at the bottom of the viewport): Принять (A), Отклонить (R), Перезапуск, rating 1–10, mark,
   comment. Reason chips are always reachable, and selecting Reject highlights them.

On the right is a collapsible **"Почему"** panel. Failed checks come first, with a jump to `atSeconds`. Passed checks are
folded into "ещё N пройдено". Generation parameters are on a second tab.

The **wave picker** is a compact list of rows: a short label (the group id, with the title truncated to one line) and the
number waiting. Only waves with waiting tracks show by default, with "показать проверенные (N)". The plan order and
`nextOpenWave` stay as they are.

### 2.2 Plan card

- One primary action, "Проверить (N)", with a visible caption next to the review-rejected switch.
- "Завершить" and "Отменить план" move into a "⋯" menu. The existing `ConfirmDialog` stays, with `danger` for cancel.
- Waves are listed newest first (the reverse of plan order). Each wave row has:
  - "Проверить (N)" when N > 0, which opens the review on that wave (`?wave=`);
  - neutral counts, with colour only when the count is above zero;
  - the owner note as an icon button with a tooltip.
- Waves with nothing waiting and nothing generating are folded into "ещё N волн".
- The owner-review stage line states the remainder explicitly ("ждут N").

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
- The keyboard map (`reviewKeyAction`), auto-advance, claims (track and wave), "Replace?" (`plan_verdict_exists`), the verdict
  history and the peer-device paths.
- The routes `/media/plans`, `/media/jobs` and `/media/plans/<id>/review` (BL-149 AC-RT-07).
- The conventions `ToggleSwitch`, `ConfirmDialog` and no native dialogs, and every label in `en` and `ru` (AGENTS.md §H).
- The exported helpers the existing tests import keep their behaviour. A changed expectation needs a stated requirement
  (AGENTS.md §L).

## 4. Acceptance criteria (defined before implementation)

- **AC-UX-01** Every switch in Media (plan card, review) has visible caption text next to it, with a key in `en` and `ru`.
- **AC-UX-02** At a 1280×800 viewport, with a wave chosen and the wave context collapsed, Accept, Reject and Re-run are visible
  without scrolling, and so are the waveform and the play control.
- **AC-UX-03** Wave context (prompt, lyrics, differing params) is collapsed by default, and one control expands it.
- **AC-UX-04** The review heading is one line: plan, wave short label, waiting / total. The full wave title is reachable
  through the expanded context or a tooltip.
- **AC-UX-05** The track line shows the item key and the seed. The attempt reference is not shown in full by default and can
  be copied.
- **AC-UX-06** A validator-rejected track lists its failed checks before any passed check. Passed checks are collapsed with
  their count.
- **AC-UX-07** The wave picker shows waves with waiting tracks by default. Fully reviewed waves stay reachable through one
  control.
- **AC-UX-08** The plan card has exactly one primary button. Complete and Cancel are reachable through a menu and still
  confirm through `ConfirmDialog`.
- **AC-UX-09** A wave with N > 0 waiting has "Проверить (N)". It opens `/media/plans/<id>/review?wave=<groupId>` with that
  wave chosen and its first waiting, unclaimed track on screen. Without `?wave=` the screen behaves as today.
- **AC-UX-10** Plan-card waves are listed newest first. A wave with zero waiting, zero accepted and zero rejected shows no
  coloured counts.
- **AC-UX-11** Jobs: a job linked to a plan shows the plan id and the item key. The empty-session hint names Servers →
  Sessions. The janitor buttons are in Servers → Setup and no longer in Media → Jobs.
- **AC-UX-12** The keyboard map, verdict payloads and API calls are unchanged. The existing
  `plan-review-screen.test.ts` / `generation-plans-panel.test.ts` pass unchanged.

## 5. FO-REQ-0013 (plans the same on every computer)

The redesign gives the review screen a single mode, with no "read-only on this device" look. Making the wave note, "take
this wave" and claims work from a device that does not own the plan is a sync change. It touches the ownership model of
DEV-RESP-0008 §3. It needs its own design, the full AGENTS.md §A reading pass and a DEV-RESP to the Factory Operator. The
owner chooses whether it rides on this branch or follows it (question 2 in msg 2242).

## 6. Slices (one branch, one merge approval)

1. Review screen (AC-UX-01..07, 09 review side, 12).
2. Plan card (AC-UX-01, 08..10).
3. Jobs (AC-UX-11).

## 7. Open questions to the owner (msg 2242)

1. Is the concept accepted, or does it need changes?
2. FO-REQ-0013: (a) UI first and sync next, or (b) both in one branch?
3. Should an interactive prototype of the review screen come first?
