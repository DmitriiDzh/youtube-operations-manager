# Generation plans, phase 3: notices, agent read tools, listening tools (BL-143)

**Decided** by the owner in Telegram on 2026-10-07:
- msg 1931: all three phases;
- msg 1933: loudness match, spectrogram and rating in phase 3;
- msg 1939: the FO-MSG-0008 additions;
- msg 1962: the scope below.

**A/B against a reference track** waits for the Factory Operator's answer to DEV-MSG-0003 (where references live, how many, their
LUFS). It is not in this branch until then.

The budget stays a warning only (Q2), so there is no hard stop.

## Scope and acceptance criteria (written before the code)

**Notices and badge**
- **AC-GP3-01: plan notices.** A plan's derived `notices` list:
  - `stage_complete` for each stage whose done/accepted count reached the planned count;
  - `budget_80` / `budget_100` (the phase 1 warnings);
  - `plan_complete` when no item is missing anything and no attempt is open;
  - `review_waiting` with the number of attempts waiting for the owner.

  The plan card shows them; the factory reads them in `factory_plan_get`.
- **AC-GP3-02: the Production badge.** `GET /api/generation-plans/summary` → `{ waitingReview }`. The count covers this device's
  active plans plus other devices' active plans (minus verdicts already sent from here). The dashboard's Production menu item
  shows it when it is above 0, refreshed about once a minute.

**Agent read tools**
- **AC-GP3-03:** `agent_list_generation_plans` / `agent_get_generation_plan` are classified `bound` and read-only. They return
  only plans of the session's active channel; another channel's plan answers `plan_not_found`. They never return item
  `params`, review audio paths or events with error text. Agent API 3.8.0.

**Listening tools**
- **AC-GP3-04: loudness-matched playback** (toggle, on by default).
  - Each track plays at volume `10^((target − lufs)/20)`, capped at 1. The target is −16 LUFS, so loud tracks are turned down
    and none is boosted beyond its own level.
  - `lufs` comes from the validator's `metrics.lufs`. Without it, it is measured in the browser from the decoded audio
    (ITU-R BS.1770: K-weighting, 400 ms blocks, −70 LUFS absolute gate and −10 LU relative gate).
  - The measurement is tested against known signals: a 1 kHz sine at −20 dBFS reads about −20 LUFS (±0.5), a 2× amplitude
    reads 6 LU louder, and silence gives no value.
- **AC-GP3-05: spectrogram** (toggle, off by default). It is shown under the waveform from the same decoded audio; nothing new
  is fetched.
- **AC-GP3-06: region loop.** Drag on the waveform to select a range. "Loop" replays it until switched off or cleared. A
  selection never changes a verdict marker unless "Mark" is pressed.

**A/B and validator highlights** (FO-MSG-0009; the owner's OK was relayed by the operator).
- **AC-GP3-07: reference tracks.**
  - A plan carries up to 50 `references: [{ id, label, file (relative to Sent to YTM), lufs?, lra?, truePeak? }]`, set through
    create/update/import.
  - A report row may name up to 5 `referenceIds` of that plan; an unknown one is refused with `plan_mismatch`.
  - `GET .../reference?id=` serves only a file the plan names, with the same rules as an audition.
  - The review screen offers the attempt's nearest references first, then the plan's others. "A/B" (key B) switches between the
    track and the reference at the same position, each at its matched loudness.
- **AC-GP3-08: spectrogram marks.** The frequencies of a ringing check's `detail` and `metrics.held_hz` are marked on the
  spectrogram. Repeats and dropouts arrive as `atSeconds` markers, as before.

## Slices (one branch `feature/generation-plans-phase-3`)

1. Notices + summary badge (AC-01, 02).
2. Agent read tools (AC-03).
3. Listening tools (AC-04..06).
4. A/B and spectrogram marks (AC-07, 08), schema v68.
