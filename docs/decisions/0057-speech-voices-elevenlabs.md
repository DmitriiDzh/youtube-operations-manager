# 0057. Speech in designed channel voices: Gemini TTS as a job kind, a shared voice registry, ElevenLabs as its own module

Status: Accepted for building (owner, Telegram msgs 3814–3817, 2026-10-29: all stages in one branch). Request: FO-REQ-0050 (BL-236),
research R-0005. Plan: `docs/roadmap/plans/SUMIRE_VOICE_PLAN.md`.

## Context

The mascot Sumire speaks (greetings, 30–60 s story Shorts). The Operator asked for speech through Gemini TTS (the key we have) and
ElevenLabs (Starter subscription), with a stored, owner-approved voice per channel, "fitted carefully into what exists". Owner
decisions: Gemini output stays its native 24 kHz WAV (no resampling); ElevenLabs on the cheapest plan — whatever output format it
allows (default `mp3_44100_128`), limits counted in **characters**, not dollars; designed voices only, **no cloning anywhere**;
adult voices.

## Decision

1. **Gemini speech is a job kind of `gemini-media`** (`speech`), not a new subsystem: the same table (`kind` is TEXT in SQL), key,
   owner switch, USD limits (shared by the computers on the key, ADR 0039), spend, worker, `From YTM/gemini/<jobId>/` folder and
   manifest (kind `speech`, the real sample rate). Output `take-1.wav`: raw PCM wrapped in a WAV header at Google's rate (shared
   module `src/lib/shared-audio`). Estimate: text length at 5 characters/s × 25 audio tokens/s at the price in force (the documented
   doubling on 2027-01-01 is a dated constant); cost = Google's counts, never below the file's length × the table price.
   `factory_gemini_create_job` does not take speech; the speech surface below does.
2. **A paid voice design is a recorded job** (`voice_design` kind, in each provider's own job table): it passes the provider's
   switch, key and limits and counts in its spend; it is sent at once (row `submitting` → `done`/`failed`), never queued.
3. **The voice registry is a shared module** (`src/lib/voice-registry`, table `channel_voices`, schema v115, device-local). It imports
   no provider: each provider is a `VoiceProviderPort` (`design`, `save`) injected by `src/composition/speech.ts`; the providers
   resolve a job's voice through the registry's resolver only (an APPROVED voice of that channel and provider, else
   `voice_not_approved`). A design keeps every preview as a file in `From YTM/<provider>/voices/<voiceId>/`; the owner approves
   one (Web, or relayed by `factory_voice_pick`): ElevenLabs then saves that generated voice and returns its `voice_id`, Gemini keeps
   the preview's persistent voice id. Names are unique per channel + provider among voices not archived.
4. **ElevenLabs is its own feature module** (`src/lib/elevenlabs-speech`, table `elevenlabs_speech_jobs`), shaped like
   gemini-media, reaching `api.elevenlabs.io` only through the new gateway child `src/lib/media-gateway/elevenlabs-api.ts` (traffic
   category `elevenlabs_api`; key in `xi-api-key` to that origin only; no redirect). Key in the device-secret slot `elevenlabs`
   (last 4 shown). Switch off by default per computer: then no take or design is sent (the only calls left are the owner's free ones --
   checking a key, reading the account's characters on request, saving an approved voice). Limits per take / day / month in characters
   plus active jobs, shared by every computer with the day / month summed over the computers on the same key (see Deviations); USD is a
   list-price estimate for spend views only.
7. **(Review fixes)** A design reserves its draft row (the name) BEFORE the paid call; a failed design archives it with the error,
   unwritten previews leave a draft with the error. One take must fit the call's timeout: Gemini ≤ 2,500 characters with a 6-minute
   long-wait call, ElevenLabs ≤ 5,000 characters with a 4.5-minute call (under fetch's 300 s header wait). A `pcm_*` ElevenLabs format
   is saved as WAV at that format's rate whatever mime comes back. Boot sweeps leave a voice design whose own call may still run.
5. **One MCP surface for both providers** (Factory API 1.40.0): `factory_speech_get_status` / `_create_job` / `_get_job`,
   `factory_voice_list` / `_design` / `_pick` / `_update`. The approval relay is named `pick`, not `approve`: no factory tool
   approves for anyone (AC-FO-09). Channel workers (Agent API 4.14.0): `agent_speech_*` pinned to their channel on the BL-218
   paid terms, `agent_voice_list` read-only; they cannot design, pick, rename or archive.
6. **No cloning, enforced:** no schema of the registry, the providers or MCP accepts audio; no gateway child exposes a clone /
   replicate function or reaches a cloning endpoint (`media-gateway/no-clone.test.ts`).

## Deviations from the approved design (documented)

- **ElevenLabs limits and spend are shared like Gemini's** (owner, Telegram 2026-10-29, msg 3823: «как у других API»): the four
  character limits (per take, day, month, active jobs) live in their own Automerge document, sync family `elevenlabs_settings`
  (`ytm-elevenlabs-settings`, the media-settings engine, ADR 0030's rules: a save publishes only what it changed, local values seed
  the document, a value set differently on two computers is a conflict held until the owner picks one -- startup window / Merge, group
  «Лимиты ElevenLabs»); the switch and the output format stay per computer. Each computer publishes its characters and list-price USD
  for today and the month in a per-device report, family `elevenlabs_spend` (`ytm-elevenlabs-spend` v1), named by an HMAC fingerprint of
  its key (`ytm/elevenlabs-key-fingerprint/v1`); the day and month limits are checked against the sum over the computers with the same
  fingerprint (ADR 0039's rules). ElevenLabs' own character count stays on the Settings card on demand.
- **ElevenLabs jobs are not in the shared media-jobs report** (its `source` enum is strict; widening it breaks older builds'
  parsing). Gemini speech jobs are there (as `audio`). RISK-142.
- (Review item 3) **restart-when-idle waits for ElevenLabs takes and designs** too: a new reason `elevenlabs_job` (queued,
  submitting or running rows of `elevenlabs_speech_jobs`), like `gemini_job`. `stop.sh`'s media-idle check still looks at Gemini only.

## Unverified (no provider call was made while building; the owner makes the first paid ones)

Gemini: the speech request fields (`response_format.type = "audio"`, `speech_config.voice` / `.style`), the voice-design endpoint
and its answer fields (`voice_id` | `id` | `name`; `sample_audio` …), the audio block shape (parsed tolerantly: Interactions `audio`
blocks or classic `candidates[].content.parts[].inlineData`), the TTS prices. ElevenLabs: the `eleven_v4` model id, the
`character-cost` header, the design/save field names, which output formats the Starter plan allows. All marked in code comments;
RISK-143.

## Consequences

Two new tables (schema v115, additive), one traffic category, one secret slot, one gateway child, two feature modules + one shared
module, seven factory and four agent tools. Gemini designed voices live about a year and a project holds at most 200 (RISK-144).
