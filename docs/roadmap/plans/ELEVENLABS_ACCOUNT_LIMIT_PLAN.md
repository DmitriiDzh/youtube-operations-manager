# BL-250 — ElevenLabs monthly limit from the account (plan and acceptance criteria)

Owner, Telegram 2026-11-14: msg 4203 («можно ли это значение брать по api с eleven labs? Чтобы брать лимит аккаунта, а не задавать
новый»), msg 4205 («Да, делай. Мы записываем в память это значение и храним как наш порог»), msg 4207 (refresh schedule from msg 4206
without the hourly background read). Amends ADR 0057 (the monthly limit was an owner number shared by the computers).

## What changes
- ElevenLabs' `GET /v1/user/subscription` (free; `character_limit`, `character_count`, `next_character_count_reset_unix`, `tier`) is
  read and **stored** on this computer as a snapshot bound to the key's fingerprint (app setting `elevenlabs_account_snapshot`; no
  schema change). Its `characterLimit` is the monthly threshold; the owner's `maxCharsPerMonth` stays as the fallback.
- Units: ElevenLabs counts credits ("characters"); a take costs at most its text length (eleven_v4 ≈ 0.44 credits per character).
  So a job's text length is an upper bound for anything not yet charged; a finished job counts what ElevenLabs reported.
- Per-take, per-day and active-job limits are unchanged.

## When it is read (msg 4206 minus the hourly read, msg 4207)
1. At server start (the first ElevenLabs loop tick), only when the switch is on, a key is stored and the media gateway is on.
2. Before a take or a voice design when the snapshot is older than 10 minutes or its reset date has passed -- outside the create lock
   (a slow ElevenLabs never blocks job creation); a failed read keeps the stored snapshot.
3. Once right after the stored reset date (the loop sees `now >= nextResetAt` and `readAt < nextResetAt`), switch on only; a failed
   read there is retried at most once an hour, and the start read counts as done even when it fails (review: no 30 s retries).
4. When the owner saves or checks the key (those calls already read the subscription: the result is stored instead of discarded).
5. The owner's «Обновить» on the Settings card (any switch state: the owner's own free read).
Never automatically while the switch is off (the module's promise, contracts.ts header).

## The monthly check (three states)
| State | Threshold | Used |
|---|---|---|
| A: no snapshot for the current key (never read, key replaced/removed, every read failed) | `maxCharsPerMonth` (owner) | this computer + the other computers on the key, calendar month (as before) |
| B: snapshot for the current key, before its reset date (any age: a failed refresh works from the last saved value) | `characterLimit` | `characterCount` + this computer's jobs that are active or were submitted after `readAt` |
| C: snapshot for the current key, reset date passed, not yet re-read | `characterLimit` | this computer's jobs that are active or were submitted after the reset date |
The other computers are not added in B/C: `characterCount` already includes them (they are re-read on their own computers).

## Acceptance criteria (hand-computed in the tests)
- AC-EA-1 A refresh stores `{ tier, characterLimit, characterCount, nextResetAt, readAt, keyFingerprint }`; a null `characterLimit` is
  never stored; a failed read leaves the stored snapshot unchanged.
- AC-EA-2 State B: limit 30 000, count 29 000, a 600-character take submitted after the read → used 29 600; a 400-character take fits
  (30 000 = limit passes), a 401-character take is refused `per_month` with `source: "elevenlabs_account"`, `limitChars: 30000`,
  `usedChars: 29600`, `resetAt`.
- AC-EA-3 State A: no snapshot → the owner's `maxCharsPerMonth` and the old counting decide (`source: "settings"`); a snapshot of
  another key is ignored.
- AC-EA-4 State C: after the reset date, only jobs since the reset count against the stored limit.
- AC-EA-5 A take reads the account first when the snapshot is older than 10 minutes (one `getSubscription` call), not when it is
  fresher; a failed read still lets the take through on the stored snapshot.
- AC-EA-6 The loop tick reads at start and right after the reset date, only with the switch on; never with the switch off.
- AC-EA-7 Saving / checking the key stores the snapshot.
- AC-EA-6b A failing account is read once at start (not every tick); a failed post-reset read retries at most hourly.
- AC-EA-2b A take sent before the read but finished after it still counts (`readAt` = when the request left).
- AC-EA-8 `getStatus` shows the stored snapshot (`account`) and `monthlyLimit { source, limitChars }` without any ElevenLabs call;
  every existing per-month test (the fallback) passes unchanged with no snapshot.

## Interfaces
Factory API 1.44.0 / Agent API 4.18.0 (additive): `factory_speech_get_status` → `elevenlabs.accountLimit` (the stored snapshot or
null) and `elevenlabs.monthlyLimit { source: "elevenlabs_account" | "settings", limitChars, usedChars, resetAt }`; an
`elevenlabs_limit_exceeded` with `limit: "per_month"` adds `source` and `resetAt`. Windows keeps the owner's number until it updates.
