# Channel title and description translations (BL-210)

## Sources

- The owner, Telegram, 2026-10-21:
  - msg 3343 asks for translations of the channel description;
  - msg 3345 asks for the name too;
  - msg 3347 chooses option 3: the Operator prepares over MCP, the owner applies, and there is also a manual card.
- The owner's authorization of this third localization writer (AGENTS.md §F): msgs 3343/3347. It gets its own ADR (0047),
  like ADR 0045.

## What it does

1. **A stored set per channel.** For each language, a channel `title` and `description`.
   - It is stored locally, per channel and per device, the same way as BL-207's `live_streams.localizations_json`.
   - Saving replaces the stored set. Nothing is sent to YouTube on save.
   - Validation follows the official `channels` resource limits:
     - the agent first checks them in the Data API v3 reference: title length, description length, no `<` or `>`;
     - languages use the exact supported YouTube codes (`src/lib/youtube-supported-languages.ts`);
     - the channel's own base language is refused.
2. **Apply.** The owner presses «Применить» in the Web UI. This is the only way anything reaches YouTube.
   - **Identity:** `write-context.assertWriteChannel` for the channel, then `assertLiveWritesAuthorized` right before the
     gateway call.
   - **Read:** `channels.list part=snippet,localizations,brandingSettings` (whatever the update needs) through the read gateway.
   - **Merge:** through `src/lib/shared-localization-merge/`:
     - the set's languages are added or replaced;
     - every other existing language is kept;
     - nothing is deleted;
     - the base `snippet.title` and `snippet.description` stay untouched;
     - the base language is never written as a localization.
   - **Backup:** the full read resource is saved before the write.
   - **Write:** a new gateway function `updateChannelLocalizations` in `src/lib/youtube-write-gateway/` (`channels.update`,
     listed in `WRITE_PRIMITIVE_NAMES`). It sends the part(s) needed with the FULL merged localizations.
   - **Read back:**
     - every set language matches;
     - the other languages are unchanged;
     - the base title, description and default language are unchanged (or, in the case below, now equal to the baseline).
     - Otherwise the result is `ok: false` with what differed.
   - **Audit:** an event with the channel, the languages, the backup id and the result.
3. **Base language.** If the channel has no default language (the property the API requires for localizations — the agent
   checks the docs: `brandingSettings.channel.defaultLanguage` or `snippet.defaultLanguage`):
   - the preview says so;
   - Apply sets it to the channel's baseline language (channel language settings) in the same update.
   - If a part has to be sent whole (e.g. `brandingSettings`), every other field of it is sent back exactly as read. A
     test proves no other field changes.
   - No baseline → refused, `no_baseline`.
4. **Preview.** Before Apply the card shows:
   - per language: new / changed / unchanged;
   - the languages that stay untouched;
   - the default-language change, if any;
   - the quota cost.
5. **MCP (Factory Operator)**: `factory_channel_save_localizations { channelId, localizations: { <lang>: { title,
   description } } }` saves only (no YouTube call). `factory_channel_get_localizations { channelId }` returns:
   - the stored set;
   - the live channel localizations, read at no write cost;
   - the last apply result.

   This is Factory API 1.29.0. It is a WRITE tool to local storage only, never a YouTube write (AC-UP-14-style test: no MCP
   path reaches `updateChannelLocalizations`).
6. **UI.** A card «Переводы канала» on the channel's settings page (or the channel section where the channel's languages
   live):
   - edit the set by hand;
   - see the preview;
   - press «Применить».

   Keys go into en and ru.

## Acceptance (written before the code)

- **AC-CL-01** Saving a valid set (es, de) stores it; nothing is sent to YouTube.
- **AC-CL-02** Validation refuses the whole save (`validation_failed`, `details.refused`) for:
  - `pt-br` (hint `pt-BR`);
  - the base language;
  - a title over the limit;
  - `<` in a description.
- **AC-CL-03** Apply with the channel holding fr and es, and a set of es and de:
  - the write sends fr unchanged, es new and de new;
  - the base title and description are not in any changed field;
  - read-back ok.
- **AC-CL-04** Apply never deletes a language: with the channel holding ja and a set without ja, ja is still sent.
- **AC-CL-05** Wrong channel (the active credentials belong to another channel) → refused before any write
  (`assertWriteChannel`).
- **AC-CL-06** Live writes off → refused, and no gateway write is made.
- **AC-CL-07** Read-back shows es differing → `ok: false`, `read_back_mismatch`, and the backup is kept.
- **AC-CL-08** The channel has no default language and the baseline is en → the update sets it to en. Every other field of
  that part equals what was read.
- **AC-CL-09** No baseline → `no_baseline`, and no write.
- **AC-CL-10** No MCP tool or agent endpoint can reach the YouTube write: only the Web UI route calls apply.
- **AC-CL-11** `factory_channel_get_localizations` returns the stored set, the live localizations and the last result.
- **AC-CL-12** The gateway inventory test lists `channels.update` only inside `youtube-write-gateway`.
