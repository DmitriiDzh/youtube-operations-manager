# BL-253 — ElevenLabs sound effects and music jobs (FO-REQ-0054 + addition, PRD-REQ-0176/0177)

Operator FO-REQ-0054 (2026-11-14): owner TG 2089 «попробуй сделать набор звуков в eleven labs» (soft SFX pack for WWE) and TG
2091 (WWE goes to other networks, so the YouTube Audio Library track must go: ElevenLabs Music). The owner's standing terminal
OK covers ElevenLabs on Producer requests within the YTM limits. Extends `src/lib/elevenlabs-speech/` (ADR 0057, amendment 2).

## Shape
- Two new job kinds next to `speech` and `voice_design`: `sfx` (POST `/v1/sound-generation`, model `eleven_text_to_sound_v2`)
  and `music` (POST `/v1/music`, model `music_v2_5`; `music_v1` is deprecated by ElevenLabs for 31.01.2027). Both through the
  media gateway's `elevenlabs-api.ts` (the one ElevenLabs gateway); the key never leaves YTM.
- Factory API: `factory_sfx_create_job {channelId, text, durationSeconds? (0.5–30), promptInfluence? (0–1), loop?, outputFormat?,
  requestId?, dryRun?, videoNumber?}` and `factory_music_create_job {channelId, prompt, durationSeconds (10–180: inside the call's 270 s timeout),
  forceInstrumental? (default true), outputFormat?, requestId?, dryRun?, videoNumber?}`; results with
  `factory_speech_get_job {jobId}` (kind `sfx` / `music`). Not given to channel workers (not asked).
- Output: `99 Data Exchange/From YTM/elevenlabs/<jobId>/sfx-1.<ext>` / `music-1.<ext>`, manifest.json last
  (kind, prompt, duration, model, the account tier read by BL-250, cost).
- Limits: the same switch and the same per-job / per-day / per-month / active-job limits as speech. They are counted in
  ElevenLabs credits (= the "characters" the limits already count). Costs from elevenlabs.io (read 14.11): sound effects
  **40 credits per second** when the duration is given; with automatic duration the job reserves the 30 s maximum (1,200)
  and is counted afterwards at 40 × the measured length; music **≈ 900 credits per minute**. A `character-cost` answer
  header, when ElevenLabs sends one, wins. The dry run shows the credits and the allowed / refused verdict.
- Terms (Operator, music-terms 09.10.2026): the manifest records model and tier so SOURCES.md can name them.

## Acceptance criteria (before code)
- AC-1 sfx with `durationSeconds: 1.2` is counted at ceil(40 × 1.2) = 48 credits; music 90 s at ceil(900 × 1.5) = 1,350.
- AC-2 sfx without a duration reserves 1,200 credits for the limits; after the take it is counted at ceil(40 × the file's
  length) (or the answer's `character-cost`), never more than 1,200; an mp3's length from its size and the format's bitrate.
- AC-3 A dry run sends nothing and returns credits, the estimate and `allowed` / `refusal`; with the switch off or no key it
  still answers (refusal), a real job is refused.
- AC-4 Over a limit (per job, day, month — the BL-250 account threshold included — or active jobs) the job is refused with
  `elevenlabs_limit_exceeded`, exactly as speech.
- AC-5 The worker sends sfx to `/v1/sound-generation?output_format=…` with `{text, model_id, duration_seconds?,
  prompt_influence?, loop?}` and music to `/v1/music?output_format=…` with `{prompt, music_length_ms, force_instrumental,
  model_id}`; it writes `sfx-1.mp3` / `music-1.mp3` and the manifest last, registers the asset (`generated_audio`).
- AC-6 Out-of-range inputs are refused before anything is stored (duration, prompt length, promptInfluence).
- AC-7 Switching the module off fails queued sfx / music jobs unsent (0 credits), as speech.
- AC-8 `factory_speech_get_job` returns an sfx / music job by id; its listings include them (field `kind`), speech jobs unchanged.

## Not in scope
Channel worker tools; composition plans / sections for music; stems; voice changer; the Settings card's wording beyond
listing the new kinds in the usage.
