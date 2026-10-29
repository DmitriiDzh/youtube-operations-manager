# SUMIRE_VOICE_PLAN — speech in designed voices (BL-236, FO-REQ-0050, ADR 0057)

Owner: msgs 3814–3817 (2026-10-29) — all stages in one branch; Gemini native 24 kHz WAV; ElevenLabs cheapest plan, limits in
characters, default `mp3_44100_128`; designed voices only, no cloning; adult voices.

| Stage | What | Where |
|---|---|---|
| S1 | Gemini `speech` job kind + paid `voice_design` record; `generateSpeech` / `designVoice` in the gateway; WAV from PCM | `src/lib/gemini-media`, `media-gateway/gemini-api.ts`, `src/lib/shared-audio` |
| S2 | Channel voice registry: design → previews (files) → owner approves one; resolver for jobs | `src/lib/voice-registry`, table `channel_voices` (v115) |
| S3 | Settings → Cloud APIs: ElevenLabs card; Media → Music: «Голоса» (play, approve, rename, archive); speech in the Gemini card | `src/components/elevenlabs-settings.tsx`, `channel-voices-panel.tsx` |
| S4 | ElevenLabs module, gateway child, secret slot, worker loop | `src/lib/elevenlabs-speech`, `media-gateway/elevenlabs-api.ts`, table `elevenlabs_speech_jobs` |
| MCP | `factory_speech_*`, `factory_voice_*` (1.40.0); `agent_speech_*`, `agent_voice_list` (4.14.0) | `src/composition/speech.ts`, `src/mcp/*` |

Acceptance (Operator + owner): design "Sumire" in both providers, approve one preview each, make the same greeting and a 45 s story
with each, review blind in the plan review (`auditionFile: From YTM/<provider>/<jobId>/take-1.*`). First paid calls by the owner.

Known gaps: RISK-142 (ElevenLabs per computer, not in the shared jobs report or restart wait), RISK-143 (unverified provider
fields), RISK-144 (Gemini voice lifetime and project limit).
