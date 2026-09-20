# Studio-Parity UI Plan — Home / Content / Analytics / Languages

Produced 2026-09-20, per the project owner's Telegram request (msg 122): "разберать какая
информация представлена [в Home, Content, Analytics, Languages разделах реальной YouTube
Studio] и сделать подробный план с тасками чтобы реализовать у нас аналогичные закладки с таким
же визуалом и отображением как в оригинальной studio." **This is a plan, not an implementation.**
Nothing here authorizes writing UI code, extending the sync schema, requesting a new OAuth scope,
or any other change — each slice below needs its own explicit assignment (`AGENTS.md` §C), same
as every other roadmap item.

This is a deliberate detour from the day's other work (RISK-02 fix, start.sh auto-update,
Settings version card) — a new planning artifact, not a continuation of any of those.

## 1. How this relates to the existing roadmap

`docs/roadmap/FUTURE_PHASES.md` §4 ("Phase 8 — Intelligence Foundation") already scopes a YouTube
Analytics API integration at the strategic/backend level, and `docs/roadmap/plans/PHASE_8_PLAN.md`
(delivered, BL-003) already designed its smallest useful vertical slice (manual view-count
collection only, no OAuth re-consent yet, no UI). **The Analytics-tab portion of this request is
the same Phase 8, but asking for it to be built out to full Studio UI parity** — a much larger
scope than Phase 8's own planned first slice. This document treats Phase 8's existing plan as the
foundation Analytics-tab parity sits on top of, not something to redesign.

Content and Languages tabs are **not** gated on Phase 8 at all — they only need capabilities this
app already has (YouTube Data API v3, the existing `channel-sync`/`localization` domain modules).

## 2. What real YouTube Studio actually shows (live research, 2026-09-20, against the "Tropico Jazz" channel)

### 2.1 Content

Sidebar item "Контент" → sub-tabs: Видео, Shorts, Трансляции, Записи, Плейлисты, Подкасты, Курсы,
Рекламные кампании, Коллаборации, Идеи. The Videos table's columns, in order: **Видео**
(checkbox + thumbnail with duration overlay + title + description snippet + processing-status
badge) · **Уведомления** · **Доступ** (visibility/privacy, e.g. globe icon + "Для всех") ·
**Дата** (with a "Публикация" sub-label) · **Просмотры** · **Комментарии**. No Likes column by
default. A filter bar sits above the table; pagination footer shows a rows-per-page selector and
an "N–M of Total" range. Clicking a video opens a Details view with its own left sub-nav
(Сведения / Аналитика / Редактор / Комментарии / Субтитры / Заявки / Клипы и Shorts).

### 2.2 Languages

Its own **top-level sidebar item** ("Языки"), not nested under Content or Analytics. Full real
sidebar order: Главная, Контент, Аналитика, Сообщество, **Языки**, Обнаружение контента,
Монетизация, Настройка канала, Фонотека. The page ("Языки канала") has sub-tabs Все / Черновики /
Опубликованные and a table: **Видео** (thumbnail+title+description) · **Языки** (count of
localized languages for that video) · **Дата изменения**. Clicking a row opens
`/video/<id>/translations` — for a video with zero translations yet, it first asks for a default
video language (searchable dropdown + a "show my channel by default in this language" checkbox)
before the add/edit-translation grid appears.

### 2.3 Home

Two-column dashboard under "Панель управления каналом". Left: "Эффективность последнего видео"
(thumbnail, views/comments/likes row, time-since-publish, rank-by-views among recent uploads,
impressions CTR, average view duration, an "Ask Studio" AI entry point) then "Опубликованные
видео" (scrollable recent-uploads list, each row = thumbnail + title + views/comments/likes
icons). Right: "Комментарии" (recent comment feed: avatar, handle, relative time, text, video
thumbnail), "Новые подписчики" (last-90-days list with each subscriber's own subscriber count),
"Аналитика по каналу" (subscriber count + 28-day delta, a views/watch-time mini-summary with
trend arrows, "Самый популярный контент" by last-48h views), and a community-post promo card.

### 2.4 Analytics

Sidebar "Аналитика" → top tabs **Обзор, Контент, Аудитория, Тренды** (Google has since renamed
what used to be "Research" to "Тренды"), plus AI "Ask Studio" prompt chips and a date-range
picker. Обзор: total-views headline, 3 metric cards (Просмотры/Время просмотра/Подписчики each
with a %-vs-previous-period badge), a views-over-time chart, a real-time panel (live subscriber
count + last-48h views bar chart), and a top-content mini table. Контент: Видео/Плейлисты
sub-tabs, 4 metric cards (Просмотры, Показы значков/impressions, CTR, средняя продолжительность
просмотра), a per-video-marker views chart, and an audience-retention module (Вступление/Лучшие
моменты/Пики/Спады). Video-level Analytics mirrors this (Обзор/Охват/Взаимодействие/Аудитория)
plus a traffic-source percentage breakdown.

**Every number in Analytics — trend deltas, CTR, impressions, real-time, retention curves,
traffic sources, subscriber deltas — requires the YouTube Analytics API v2 (`youtubeAnalytics`)
and a new OAuth scope (`yt-analytics.readonly` at minimum). None of it is obtainable from the
Data API v3 this app currently uses exclusively.**

## 3. What this app already has vs. is missing, per tab

| Tab | Data already available | Missing |
|---|---|---|
| **Content** | Video list, title, description, privacy status, published date, thumbnails (`videos` table via `channel-sync`) | **View count / comment count are never synced today** — `videos.list`'s `statistics` part is not requested anywhere in `src/lib/channel-sync/adapters/youtube-api.ts`/`src/lib/youtube.ts`. This is the one real gap, not a UI-only gap. |
| **Languages** | Per-video existing localizations (`existingLocalizationLanguages`, already computed and shown in the current Localizations tab) | Nothing new at the data layer — purely a UI/IA restructuring question (see §5, open question 1). |
| **Home** (non-analytics cards) | Video list/thumbnails/dates | View/comment/like counts (same gap as Content); a recent-comments feed (no `commentThreads.list` integration exists anywhere); a recent-subscribers feed (no such integration exists; YouTube Data API v3 also does not expose *who* subscribed for a channel without a subscriber's own consent — this specific Studio module may not be fully replicable via public API at all, needs verification before promising it). |
| **Home** ("Аналитика по каналу" card) | — | Same Analytics API v2 dependency as the full Analytics tab (§2.4) |
| **Analytics** (full tab) | — | Entire new API surface: OAuth re-scoping, new adapter module, new historical storage, new UI. Already scoped at the foundation level by `docs/roadmap/plans/PHASE_8_PLAN.md`. |

## 4. Proposed slices, in a sensible dependency order

Each slice is independently assignable; nothing here is authorized by this document alone.

**Slice S1 — Sync video statistics (views/comments/likes).** Extend
`src/lib/channel-sync`'s `videos.list` call to also request the `statistics` part and persist
`viewCount`/`commentCount`/`likeCount` on the `videos` table (additive columns, `AGENTS.md` §D
pattern — one sync module, not a parallel one). Prerequisite for S2 and part of S4. Small,
self-contained, no new OAuth scope (`statistics` is already covered by the existing read scope).

**Slice S2 — Content tab (Studio-parity table).** A new/reworked "Content" view: table with
thumbnail+title+description, Access (privacy status with an icon, matching Studio's visual
language), Date, Views, Comments columns; a filter bar (by privacy status/date-range/text search
over title); pagination. Depends on S1 for the Views/Comments columns; everything else is
already-synced data. This is the most direct, lowest-risk win — closest to "just restyle
`channel-sync`'s existing video list."

**Slice S3 — Languages tab (Studio-parity table + per-video editor).** A dedicated "Languages"
nav tab: table of Video / language-count / last-modified, and a per-video language editor.
**Open design question (needs owner decision before assignment):** this app already has a
"Localizations" tab covering materially the same data (per-video existing/imported localizations,
XLSX-based import/approve workflow). Does "Languages" (a) replace/restyle the existing
Localizations tab's video-list view to match Studio's table+columns while keeping the existing
XLSX-based edit workflow untouched, or (b) become a second, separate tab alongside Localizations?
Per `AGENTS.md` §D, (a) is strongly preferred — avoid two tabs presenting the same underlying
per-video-language data through two different UIs. Recommend restyling, not duplicating.

**Slice S4 — Home tab, Data-API-v3 portion only.** "Последнее видео"/"Опубликованные видео"
cards (depends on S1 for view/comment/like numbers) — straightforward, reuses S1's data.
"Комментарии" and "Новые подписчики" cards are **each a separate, unscoped research question**:
neither `commentThreads.list` nor any subscriber-activity feed has ever been integrated in this
app. Before committing to build these, a short research pass should confirm (a) exactly what
OAuth scope `commentThreads.list` needs and whether it's already covered by the existing consent,
(b) whether a "who recently subscribed" feed is actually obtainable via Data API v3 at all for a
channel that doesn't already show subscriber counts publicly-listed, or whether Studio computes
this from data no third-party API exposes. Do not promise this card before that research exists.

**Slice S5 — Home tab, "Аналитика по каналу" summary card.** Blocked on Phase 8's Analytics API
foundation (§2.4/§3) existing first — no independent scope of its own beyond "once Phase 8's
adapter exists, add one more small consumer of it."

**Slice S6 — Analytics tab, Studio parity (Phase 8, extended to full UI).** This is
`docs/roadmap/plans/PHASE_8_PLAN.md`'s existing "smallest useful vertical slice" (views-only,
manual trigger, no chrome) as its own first step, then grown in further sub-slices toward what
§2.4 describes:
  - S6a = Phase 8's already-planned slice (OAuth re-consent decision, adapter module, additive
    historical table, manual "collect now", raw display) — see `PHASE_8_PLAN.md` for full detail,
    not repeated here.
  - S6b = Overview tab parity (views/watch-time/subscribers trend cards + a real-time panel) —
    needs additional metrics beyond views (watch time, subscriber deltas) and a distinct
    "near-real-time" query pattern Studio uses for its last-48h panel.
  - S6c = Content-analytics sub-tab parity (impressions, CTR, average view duration, audience
    retention curve) — CTR/impressions and retention are separate, more specialized Analytics
    API report dimensions; retention specifically is one of the harder ones to reproduce exactly.
  - S6d = Audience/Trends sub-tab parity (demographics, geography, device type, traffic sources).

  S6b–S6d each deserve their own acceptance criteria once S6a's foundation actually exists and
  has been validated against real data — writing detailed specs for them now, before S6a is even
  assigned, would be planning ahead of the evidence `FUTURE_PHASES.md` §4's own constraint warns
  against ("distinguish observed facts from interpretations/hypotheses explicitly").

## 5. Open questions requiring an owner decision before any slice is assigned

1. **Languages vs. Localizations** (S3): restyle the existing tab, or run two tabs side by side?
   Recommendation: restyle (avoid `AGENTS.md` §D's "parallel implementation" concern).
2. **Visual fidelity target:** a pixel-accurate clone of Studio's current layout, or "the same
   information and IA, in this app's own already-established dark theme/design language" (the
   app already went through a YouTube-Studio-*inspired* redesign, per today's earlier Windows/
   Mac UI discussion)? A literal pixel clone risks looking like an impersonation of YouTube's own
   product; "same information, our own consistent visual system" is the safer and more
   maintainable target. Recommend the latter unless the owner explicitly wants a closer clone.
3. **OAuth re-consent for Analytics** (S5/S6): adding `yt-analytics.readonly` changes what a
   signed-in user is agreeing to — needs explicit sign-off before any Analytics-related code
   requests it, exactly as `PHASE_8_PLAN.md` already flags.
4. **Comments/subscribers feeds** (part of S4): needs a short, separate research pass (scope,
   feasibility, quota cost) before being promised as buildable — see S4 above.

## 6. Recommended first assignment, if the owner wants to start now

**S1 + S2 (sync video statistics, then the Content tab)** is the smallest, lowest-risk, most
immediately visible slice: no new OAuth scope, no new external API surface, reuses the existing
`channel-sync` module and its established test patterns, and directly answers the "Content"
portion of the request. S3 (Languages restyle) is a close second, same risk profile. S4's
non-comments/non-subscribers half could follow immediately after S1. Everything analytics-related
(S5, S6) should wait for a separate, explicit decision given its materially larger scope (new
OAuth consent, new API surface, new quota model) — recommend treating S6a as its own assignment
exactly as `PHASE_8_PLAN.md` already scoped it, independent of this Studio-parity request.
