# Content section redesign (BL-221)

Owner, Telegram msgs 3439 (a UX pass over «Контент»), 3444 («Делай все в одной ветке»), 3449 (V52–V55 and V59–V61 were published
on their folder dates). Mockup and audit: Developer Telegram msgs 3442/3443; corrections in msg 3448. One branch,
`feature/content-ux-redesign`, one merge decision.

## Stages

### A. «Видео»

- Type chips with counts: **видео**, **эфир** (the channel's current broadcast, `live_streams.broadcast_id`), **запись эфира** (a
  broadcast the app ran earlier: `live_stream_segments`, `live_viewer_samples`), **пустая трансляция** (`liveBroadcastContent`
  `upcoming`/`live` that the app never ran, for example YouTube's own «Прямая трансляция пользователя»). Access chips replace the
  access `<select>`.
- Columns: Vn, access, duration, publish date, views (total), views over 7 days, CTR over 7 days, languages `present/tracked`,
  visual cost. Each column sorts.
- Sync moves into the list toolbar («обновлено ЧЧ:ММ · ⟳»).
- The top bar's count is YouTube's `statistics.videoCount` (public videos only); its text now says that, with a tooltip.
- Each extra (Vn, costs, 7-day figures, languages) is its own request: a failure shows "—", never breaks the list (§M).

### B. «Ролики и релизы» (was «Публикация»)

- A board of the channel's Vn by phase: **Подготовка** (number, storyboard or generation runs, no video file) → **Монтаж** (the
  folder has the release video, no package) → **Пакет готов** (`Vn_release.json`, not uploaded) → **На YouTube** (private /
  unlisted / scheduled) → **Опубликовано** (public). `VideoState` itself is unchanged; the phase is derived for display.
- The Vn ↔ YouTube video link (`youtubeVideoId`) comes from `video-projects`: `Vn_youtube.json`, `video_registry.csv`, this
  computer's uploads. The privacy and date come from the synced video.
- «Привязать к видео» (owner msg 3449, option б of msg 3448): a Vn with a folder but no link gets suggestions: synced videos
  published (or scheduled) on the folder's MMDD date, closest duration first. Never by title. The owner confirms. The app writes
  `Vn_youtube.json` (`result: "linked"`, `linkedBy: "owner"`) into the folder through the workspace rule. That is a local file, not
  a YouTube write.
- Costs rounded to cents («<$0.01» below a cent). Packages and publishing settings move under the board, collapsed by default.

### C. «Трансляции»

- Status first: on air or not, viewers, YouTube's stream health with a plain explanation of each `configurationIssues` type.
- Analytics full width; the settings card collapsed.
- The empty hourly chart: YouTube omits `concurrentViewers` at 0 viewers. «Live, no number» counts as 0 only after the owner
  agrees (msg 3448 q.2). Until then the chart says why it is empty.

### D. «Календарь»

- Empty days ahead (the 14-day window is unchanged) turn amber, not red. Each one gets a hint naming a ready package that could
  fill it.
- A click on a day opens that day's videos with their views.

### E. Tab badges

- «Ролики и релизы»: packages waiting for an action. «Календарь»: empty days within 7 days. «Трансляции»: stream health
  `bad`/`noData` while on air.

## Acceptance

1. The chip counts add up to the list total. A live broadcast, its earlier segments and YouTube's empty broadcast each land in
   their own chip (checked on a copy of the real DB).
2. Vn shows for every video named in the registry or a `Vn_youtube.json`.
3. Once V52 is linked, it moves to «Опубликовано» on the board and its Vn shows in «Видео».
4. A link is refused for a video of another channel, for a Vn already linked, and for a folder outside `04 Videos`.
5. No new YouTube call. Everything is a local read, except the owner-confirmed link file.
6. en + ru texts for every key. `npm test`, `npm run lint`, `npm run build` pass.
