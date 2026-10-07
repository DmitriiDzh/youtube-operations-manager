# Interface language: English + Russian, ready for any language (BL-152)

**Requested** by the owner in Telegram on 2026-10-07 (msg 2027): a Settings choice of interface language; Russian as the second language; a key/translation base so the whole UI can later go into any language; every future UI change must add keys and translations for every language.

**Status:** plan only. Not assigned; no code written. Open questions answered by the owner in Telegram on 2026-10-08 (msg 2032), see the end.

## What exists today (research, 2026-10-08, `dev` at `ba02ddd`)

- The Web UI is ~24,500 lines of `.tsx` in `src/components/` and `src/app/` (129 components, 102 of them client components). Every string is an English literal in the code. There is no i18n library and no dictionary.
- Operator-visible English also lives in `.ts` files: `section-tabs.ts` (tab names), `conflict-values.ts` (`SETTING_LABELS`, "not set", "On"/"Off"), `batch-progress.ts`, `channel-sync-client.ts`, `shared-formatting` ("Invalid date").
- Server messages reach the screen as-is: components render `data.message` (~100 places) and `data.error` (~45 places). `DomainError` (`src/lib/shared-domain`) already carries a stable `code`; about 189 route lines still return a bare `{ error: "Unauthorized" }`-style text with no code.
- Dates already use a fixed `DD.MM.YYYY` format (`shared-formatting`, owner rule 2026-09-26). Numbers do not: ~69 `toLocaleString()` calls pass no locale, so they follow the browser's locale (the same bug class as the Finnish time input).
- `<html lang="en">` and the page title are fixed in `src/app/layout.tsx`.
- `app_settings` (`src/lib/db.ts`) is a key/value table that is **per device** — not synced by the sync gateway.
- Rough size: ~1,200–1,500 strings to move into keys. Biggest files: `media-generation-settings.tsx` (2,627 lines), `languages-manager.tsx` (1,751), `decisions-manager.tsx` (1,030).

Name clash to avoid: "localization"/"languages" already mean **video** title/description translations (`src/lib/localization`, `ai-localization`, the Languages tab). The new module must use a different name: `ui-text`.

## Scope

In scope: everything the Web UI shows to a person.

Out of scope, stays English:
- MCP tool names/descriptions, API response bodies, CLI output, logs. The operations agent and scripts read them; they are a contract (AGENTS.md §B).
- Video data: titles, descriptions, channel names, language names that come from YouTube.
- Product and technical names: YouTube, MCP, RunPod, OAuth, API, GPU, Change Set IDs and similar (same rule as AGENTS.md §I). Final list is an open question (Q3).

## Design

### Module `src/lib/ui-text/` (shared, per AGENTS.md §M)

- `locales/en.ts` — the source dictionary: a flat object `{ "settings.general.title": "General", ... }`. Keys are grouped by screen: `nav.*`, `settings.*`, `content.*`, `common.*` (Save, Cancel, Loading…).
- `locales/ru.ts` — typed as `Record<keyof typeof en, string>`. A missing or extra key fails `tsc` → `npm run build` fails. A new language = one new file + one line in the language list.
- `translate(locale, key, params)` — `{name}` substitution; plurals through `Intl.PluralRules` (Russian has 3 forms: 1 видео / 2 видео / 5 видео; `{count, plural}` syntax kept tiny, no ICU library).
- `formatNumber(locale, n)` — added to `shared-formatting`; all `toLocaleString()` calls move to it. Dates keep `DD.MM.YYYY` in every language.
- React: `UiTextProvider` (client context) + `useT()` hook. The provider gets the locale from the root layout, so the first render is already in the right language (no flash of English).

**No library.** `next-intl` / `react-i18next` assume locale in the URL or middleware and pull in a runtime we do not need; we have one local user, ~16 server files (mostly empty route shells) and no SEO. A ~150-line typed dictionary covers it and gives compile-time key checks for free. If we ever need ICU message syntax, the dictionaries move to a library without rewriting call sites.

### The setting

- `app_settings` key `ui_language`, values `en` | `ru`. **Per device**, not synced (Q1): each computer shows its own language, and a language change never creates a sync conflict on the blocking startup screen.
- No saved choice → the system language (Q4): the browser's `Accept-Language` header, read in the root layout (the browser runs on the same computer and follows the OS language; Node's own locale is unreliable when the server is started without `LANG`). The first supported language wins; none supported → `en`. Nothing is saved until the person picks a language, so a later OS language change still applies. The selector shows a «System (Русский)»-style first option for this.
- `GET/PUT /api/settings` gains `uiLanguage` (validated against the language list).
- Settings → General: a "Interface language" select. Each language is shown in its own name (English, Русский). After saving, `router.refresh()` re-renders in the new language.
- `src/app/layout.tsx` reads the setting: `<html lang>`, page title, and the provider's locale.

### Server errors

- The UI translates by `code`: `errors.<CODE>` in the dictionary. Unknown code → shows the server's English `message` (never a blank). So API bodies stay English for the agent, and the UI is translated.
- The routes that return a bare text error get a `code` as they are touched; a full sweep is slice 4.

### Keeping it complete (the owner's "every new feature adds keys for every language")

1. `tsc`: `ru.ts` must have exactly the keys of `en.ts` — build fails otherwise.
2. Test `ui-text/locales.test.ts`: no empty values; every `{param}` in `en` exists in every other locale.
3. Inventory test (house style, like `loading-indicator.inventory.test.ts`): fails on English literal text in JSX/`title`/`placeholder`/`aria-label` in `src/components` and `src/app`. During migration it has an allowlist of not-yet-migrated files that only shrinks; at the end the allowlist is empty and the test is strict.
4. AGENTS.md gets a rule; DEVELOPMENT_PLAYBOOK §6.12 gets a row: "UI text → add the key to every locale".

### Translation quality

Russian texts are written by the coding agent as part of each slice and reviewed by the owner on screen. Translations follow meaning and natural Russian, not word for word (Q3). Product terms get one fixed translation each, kept in a short glossary at the top of `ru.ts`, so the same term reads the same on every screen.

## Slices (one branch `feature/ui-language`, one merge — AGENTS.md §K.1)

| # | What | Keys (approx.) |
|---|---|---|
| 1 | Module, setting, selector in Settings → General, provider, `<html lang>`, `formatNumber`, parity tests. Migrated: app shell, navigation, section tabs, Settings → General, common buttons, shared dialogs. | ~150 |
| 2 | Home, Content, Languages, Batches, Decisions, Merge | ~500 |
| 3 | Analytics, Research, Settings (other tabs), Production (incl. `media-generation-settings`) | ~650 |
| 4 | Server errors by `code` (+ codes added to bare-text routes); `.ts` label tables; number formatting everywhere; inventory test strict; AGENTS.md / playbook rules | ~150 |

Each slice is checked in the browser in both languages (long Russian words can break narrow layouts — buttons, tabs, table headers).

## Risks

- **Size.** ~1,300 strings across 129 files is a large mechanical diff; review is per slice.
- **Layout.** Russian text is ~20–30% longer; tabs and buttons need a check.
- **Missed strings** in `.ts` helpers and server messages — covered by the slice-4 sweep and the inventory test.
- **Merge conflicts** with other UI work while the branch is open — keep slices short; other UI branches merged meanwhile must add their strings through `useT()`.

## Owner decisions (Telegram, 2026-10-08, msg 2032)

- **Q1.** Each computer has its own language choice.
- **Q2.** CLI output is not translated.
- **Q3.** Translate by meaning, choosing natural, fitting Russian terms — not word for word.
- **Q4.** Default is the system language, falling back to English when that language is not available.
