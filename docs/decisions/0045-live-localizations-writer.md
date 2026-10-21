# 0045. A second localization writer: the live stream's translations, at publish

Status: Accepted

**Date:** 2026-10-21. **Decided by** the owner, Telegram msg 3257, answering the questions of msg 3254 (the Operator's request for
translated live stream titles and descriptions). Plan: `docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md` (BL-207).

## Context

- Until now the Change Set mechanism (Batches) was the only writer of per-language `title`/`description` (`localizations`).
  AGENTS.md §F and PROJECT_SPEC §21 said so, and `LIVE_STREAMS_FIELDS_PLAN.md` §2.3 kept it that way for live streams: the
  stream's settings held only the base text, and translations were to go through the normal translation screens.
- A 24/7 stream makes a new broadcast at every Start and at every BL-205 segment switch (up to every 12 hours). Each one is a new
  video, so a translation made through Change Sets would have to be redone for every segment, and the broadcast would run
  untranslated in the meantime.
- The owner decided (msg 3257):
  1. the Factory Operator sets the translations over MCP; they are also editable by hand in the Live section;
  2. one set per stream, so every broadcast and segment gets the same set;
  3. a language without a translation gets nothing written, so its viewers see the base text;
  4. this is a second authorized writer, limited to live broadcasts and to the stored set.

## Decision

1. **Storage.** `live_streams.localizations_json` (schema v101, nullable, device-local like the row): `{ "<lang>": { title,
   description } }`. One pure validator (`live-streams/localizations.ts`) for the MCP tool, the route, the store and the page:
   an exact supported YouTube code (a letter-case near-miss gets a "did you mean" hint), title 1–100 characters after trimming,
   description 1–5000 bytes (required: empty after trimming is refused, owner msg 3287), no `<` or `>`, never the channel's baseline language, at most 50 languages. One bad entry
   refuses the whole set; saving replaces the set; an empty set clears it.
2. **The writer** is a new module, `src/lib/live-localizations/`, plugged into live-streams at the app layer
   (`src/composition/live-stream-localizations.ts`, AGENTS.md §M), so live-streams still imports no other feature module and works
   without it.
3. **The step.** `applyVideoSettings` runs a `localizations` step right after the fields step, only when the fields were written
   and read back, for all three triggers (Start, «Применить снова», segment). No stored set: no step and no YouTube call.
4. **The pipeline** (AGENTS.md §G):
   1. `write-context.assertWriteChannel`;
   2. a fresh `videos.list snippet,localizations` through the read gateway; it must already show the fields step's snippet values
      (re-read while it does not), because the snippet part is sent back whole;
   3. `checkDefaultLanguage`: no `defaultLanguage`, no write;
   4. the set holding the video's own language fails closed (PROJECT_SPEC §14);
   5. a backup (`kind: "localization"`, with the snippet title/description);
   6. `buildSafeLocalizationsPayload`, now in the shared `src/lib/shared-localization-merge/` (moved from `batches/merge.ts`,
      which re-exports it): the set's languages overwritten, every other kept, nothing deleted, the snippet text untouched;
   7. `assertLiveWritesAuthorized` immediately before the one `applyVideoMetadataUpdate` (write gateway);
   8. a read-back of every written language and the snippet text, re-read a bounded number of times;
   9. audit events (BACKUP, RESULT, VERIFICATION) in the per-video edit log, `source: "live_localizations"`.
5. **The audio language.** `videos.update` resets a snippet field left out (RISK-102). The writer sends back the
   `defaultAudioLanguage` it just read (the value the fields step wrote), except `zxx`, which YouTube refuses when echoed.

## Consequences

- AGENTS.md §F, PROJECT_SPEC §21, `LIVE_STREAMS_FIELDS_PLAN.md` §2.3 and the code comments that stated the old rule are amended.
- Quota: with a set, each broadcast and segment costs one more `videos.update` (50) and two `videos.list` (fresh read and
  read-back, 1 each); the dry runs count 52.
- A read-back mismatch is a failed step (`YouTube reads back something else: language missing: … / text differs: …`), never an
  end of the broadcast. Whether a live broadcast's video reads its localizations back is not verified yet; the first real go-live
  with a set is the live acceptance, like the BL-205 spike.
- Batches and this writer share one merge rule and one locale-key rule; neither has a copy.
- Not done here: the MCP tool and status field (plan stage 4) and the Web UI card (stage 5).

## Alternatives rejected

- **Translations through Change Sets per broadcast** (the old §2.3): every segment would start untranslated and need a new
  Change Set and Batch.
- **Writing `localizations` through video-details:** that module is deliberately unable to read or write a locale; widening it
  would make every single-item edit a potential localization writer.
- **One set per broadcast or segment:** the description is per stream, and the owner chose one set (decision 2).
