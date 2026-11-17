> Moved verbatim from SYSTEM_MAP.md §2 on 2026-11-17; index: ../SYSTEM_MAP.md

### 2.9am Круглосуточная трансляция своих открытых видео канала (BL-176, FO-REQ-0019, ADR 0036, `docs/roadmap/plans/LIVE_STREAMS_PLAN.md`) — **IMPLEMENTED, влито в `dev` (`1c102a2`); реальные записи в YouTube (spike B) и приёмка §4.2 ещё не проводились**

- **Модуль `src/lib/live-streams/`** (отдельный, §M, выключен по умолчанию; работает только на Mac как системный сервис): ротация с проверкой «только открытые» (свежее чтение YouTube), карта файлов оператора, буфер оригиналов на диске Mac (текущее + следующее), процесс эфира `helper/encoder-helper.mjs` (отдельный node, переживает перезапуски), надзор и цикл раз в 15 с в `instrumentation.ts`, опрос YouTube раз в 5 мин, уведомления колокольчика. **С BL-211 (схема v105):** каждый завершённый опрос трансляции сохраняется в `live_viewer_samples` (зрители, lifecycle, состояние и здоровье потока; зрители null, если YouTube не дал числа) — без лишних запросов к YouTube; ошибка записи не ломает опрос (событие `viewer_sample_failed`). Таблица только на этом компьютере, хранится без срока (III.E.4.b, статистика своих каналов).
- **Запись в YouTube** только по кнопкам владельца (Старт / В эфир / Стоп / Изменить) через `youtube-write-gateway/live.ts` (5 примитивов в инвентаре), Live writes + `assertWriteChannel`; чтения — `getLiveBroadcasts`, `getLiveStreamStatuses` (без ключа), `readLiveStreamIngestion` (единственное чтение ключа), `getLiveViewerCounts`. Квота: 11 live-методов по 1 ед.
- **Общие модули:** `src/lib/ffmpeg-host/` (поиск ffmpeg, возможности, ffprobe; `keyframes.mjs`), `workspace-exchange.resolveWorkspaceFile`, семейство `sync-gateway/live-streams` (отчёт `ytm-live-streams` v1).
- **Схема v86:** `live_streams`, `live_stream_videos`, `live_stream_events`, `live_stream_sources` (только этот компьютер); настройки — `app_settings.live_streams_settings`.
- **Web:** Контент → «Видео» | «Трансляции» (`/content/streams`, активный канал; на Windows — только чтение из отчёта), Настройки → «Трансляции»; API `/api/channels/[channelId]/live-stream/**`, `/api/live-streams/settings`, `/api/live-streams/notices`.
- **Оператор (Factory API 1.14.0):** `factory_live_get_status`, `factory_live_map_sources`; с 1.27.0 (BL-207) — `factory_live_save_localizations` и `factory_live_get_status.localizations`.
- **BL-233 трансляции и загрузка видео делят канал Mac (FO-REQ-0047, ветка `feature/bl-233-live-upload-bandwidth`, схема v113):**
  - Свой битрейт трансляции: `live_streams.bitrate_kbps` (null = настройка компьютера), сохраняется с настройками трансляции
    (целое 1000..12000); `supervisor.encoderBitrateFor` при запуске энкодера (событие `encoder_start.bitrateSource`).
  - Общий модуль `src/lib/upload-bandwidth/` (§M, чистый, без импорта модулей): пока на компьютере включена трансляция, загрузка
    не быстрее `uploadCapMbps` (настройки трансляций компьютера, по умолчанию 2, 0 = без лимита); трансляция ниже 0.97x
    `uploadGuardMinutes` минут (3, 0 = выкл.) — новые куски не начинаются, пока все потоки минуту держат 0.99x, не дольше 30 мин.
    Скорость — за последнюю минуту по `outTime` (у ffmpeg `speed` — среднее с начала прогона).
  - Сборка в `src/composition/upload-bandwidth.ts` из `live-streams.readLiveUploadLoad()` (`encoder-load.ts`: speed/bitrate/outTime/
    отставание из `status.json`; хелпер пишет `progress.runStartedAt`); раннер загрузок получает `bandwidth` (instrumentation),
    шлюз записи — `pace` у `putVideoUploadChunk` (тело куска срезами по 64 КБ). Удержание/снятие — события `upload_held`/
    `upload_released` в истории трансляции.
  - Factory API 1.37.0 / Agent API 4.11.0: `factory_live_get_status.encoders` и `.upload`; Web — поля в «Настройки → Трансляции»,
    битрейт в настройках трансляции, строка «загрузка ограничена / на паузе» (`GET /api/publishing/upload-bandwidth`).
- **BL-234 второй источник трансляции — библиотека сегментов (FO-REQ-0048, ADR 0056, ветка `feature/bl-234-live-segments`, схема v114):**
  - `live_streams.source_mode` (null = `videos`) и `live_stream_library_segments` (выбор владельца по порядку, факты последней
    проверки); переключает только владелец в Web UI (`PUT .../live-stream/source`), действует со следующего прохода или сразу с
    «Перезапустить энкодер» / «Старт».
  - `live-streams/library.ts` (+ `adapters/library-files.ts`, только чтение): библиотека `<папка канала>/04 Videos/Live Segments/
    seg-<seq>.mp4|.json|.jpg`, только готовые (без `.part`, sidecar с тем же seq), ffprobe без сравнения с YouTube; `recheck` по
    режиму (`index.recheckLiveSource`) — пропуск отсутствующих/нечитаемых с событием, без диска — последние проверки, ни одного —
    отказ с причиной. Буфер и хелпер те же (id `seg-<seq>`); файлы библиотеки приложение не удаляет.
  - Web: карточка «Что играет трансляция», выбор сегментов и диалог библиотеки (`live-stream-library.tsx`); API
    `.../live-stream/library` (GET/POST/PUT), `.../library/[seq]` (DELETE), `.../library/[seq]/poster`.
  - Factory API 1.38.0 / Agent API 4.12.0: `factory_live_get_status.sources` (режим, библиотека, выбор, текущий сегмент и трек).
- **Аналитика эфиров (BL-211..214, `docs/roadmap/plans/LIVE_ANALYTICS_PLAN.md`, ветка `feature/bl-211-live-viewer-samples`):** замеры опроса → `live_viewer_samples` (v105); общий модуль `src/lib/live-analytics/` (§M, не зависит от `live-streams`): сводка (`summarise.ts`: интервал ≤ 10 мин относится к первому замеру, длиннее — пропуск; обрывы — `encoder_run_exit` не `pass_end`), часовой цикл выгрузки YouTube Analytics по завершённым трансляциям (`collect.ts` → `live_broadcast_analytics`, v106; через час и финально через 4 дня; через read gateway `queryOwnVideoReport`). Web: карточка «Эфиры» (`live-stream-analytics.tsx`), `GET .../live-stream/analytics?days=1..90`. Producer API 1.11.0: `producer_live_analytics` (только данные этого компьютера). **BL-222 (план §6, в `dev`, 952d6e68):** компьютер с трансляцией раз в 5 минут публикует готовые сводки (1/7/30/90 дней по каждому каналу с замерами за 90 дней) в per-device отчёт `ytm-live-analytics` v1 (`sync-gateway/live-analytics`, семейство `live_analytics`, 18-е); маршрут отвечает своими замерами, а если их нет — новейшей сводкой другого компьютера (`source: local | peer`); карточка «Эфиры» показывается и там, где трансляция идёт на другом компьютере, с подписью, откуда данные. Без вызовов YouTube.
- **BL-187 (этап 1 `docs/roadmap/plans/LIVE_STREAMS_FIELDS_PLAN.md`, ветка `feature/live-streams-fields-and-picker`, не в `dev`):**
  окно «Добавить видео…» — итоговые файлы `Vn` из `04 Videos/` с галочками (`picker.ts`, `picker-service.ts`,
  `adapters/picker-files.ts`). Совпадение файла с видео: карта оператора → `Vn_youtube.json` → `video_registry.csv`; иначе
  владелец выбирает из видео той же длительности. Добавление — `addVideos` (каждое как одиночное, с теми же проверками). API:
  `GET .../live-stream/rotation/candidates(?all=1)`, `POST .../live-stream/rotation/batch`. Только чтение диска, в YouTube не пишет.
- **Общий модуль `src/lib/workspace-videos/`** (BL-187, §M): обход `04 Videos/`, разбор `Vn_youtube.json` и реестра, чтения файлов;
  им пользуются публикация (`package-scan.ts`) и трансляции.
- **BL-186 этап 2 (тот же план и ветка, не в `dev`):** карточка «На YouTube» (`src/components/live-stream-video-settings.tsx`) —
  все поля, которые API даёт задать: обложка (JPEG/PNG ≤ 2 МБ, файл на этом компьютере в `live-streams-thumbnails/`), теги,
  категория, языки, дата записи, лицензия, ИИ, платное продвижение, счётчик лайков, плейлисты; трансляция — задержка, DVR,
  встраивание, субтитры (только «выкл»); список «Только в YouTube Studio». Схема **v92** `live_streams.video_settings_json`
  (`video-settings.ts`, `fields.ts`, проверки в `schemas.ts`); API `PUT .../live-stream/video-settings`,
  `GET|PUT|DELETE .../live-stream/thumbnail`. Сохранение в YouTube не пишет. Старт отправляет только настройки трансляции
  (в том же `liveBroadcasts.insert`, без новых единиц); настройки видео показываются в окне «Запустить» как «пока не
  отправляются» — их применение (этап 3) ждёт пробного эфира (spike C).
- **BL-186 этап 3 (2026-10-19, ветка `feature/bl-186-stage-3`, план §5.1, ADR 0036 Amendment 2026-10-19):**
  - После старта кодировщика настройки видео уходят в видео трансляции в фоне (`live-streams/video-apply.ts`):
    - одно `videos.update` через video-details (подключён портом `VideoFieldsPort` на уровне приложения, `live-stream/shared.ts`);
    - `thumbnails.set` со сверкой SHA-256 файла;
    - плейлисты через playlist-management, без дублей, с одним повтором.
  - Каждый шаг — событие `video_settings_step`, итог — `video_settings_applied`. Сбой шага эфир не останавливает.
  - «Применить настройки видео» (`GET|POST .../live-stream/apply-video-settings`): пробный прогон, затем повторная отправка.
  - video-details получил `paidProductPlacement`. Схема не менялась.
- **BL-205 сегменты (FO-REQ-0032, `docs/roadmap/plans/LIVE_SEGMENTS_PLAN.md`, ветка `feature/fo-req-0032-live-segments`, схема v99):**
  - `live-streams/segments.ts`: при включённом «Перезапуске эфира» раннер до 12 ч создаёт новую трансляцию с записью на том же потоке и выводит её в эфир, затем завершает старую (спайк D: без разрыва).
  - Сбой: старый сегмент остаётся, новый удаляется, уведомление `live_segment_switch_failed`, повтор через 30 мин, не больше 6 переключений в сутки.
  - Метка `segment_switching_json` и восстановление после падения.
  - Записи добавляются в выбранный плейлист.
  - Запись идёт через учётку канала, Live writes (ADR 0044) и проверку канала.
  - Таблица `live_stream_segments`.
  - API: `PUT .../live-stream/segments`. Карточка «Перезапуск эфира».
  - `factory_live_get_status.segments` (Factory API 1.25.0).
  - Композиция модулей для раннера и маршрутов — `src/composition/live-stream-video-fields.ts`.
- **BL-207 переводы трансляции при публикации (`docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md`, ADR 0045, ветка
  `feature/live-localizations`, этапы 1–5):**
  - Один набор переводов на трансляцию: схема **v101** `live_streams.localizations_json` (только этот компьютер);
    `live-streams/localizations.ts` — общий чистый валидатор (точный код YouTube с подсказкой регистра, заголовок 1–100,
    описание обязательно, 1–5000 байт, без `<`/`>`, не базовый язык канала, ≤ 50 языков, весь набор или ничего) и хранилище (замена,
    пустой набор очищает).
  - Второй разрешённый писатель `localizations` (`docs/WRITE_AUTHORIZATIONS.md`) — модуль `src/lib/live-localizations/`, подключается портом
    `LocalizationsPort` через `src/composition/live-stream-localizations.ts` (маршруты и раннер сегментов).
  - Шаг `localizations` в `applyVideoSettings` сразу после полей и только при их успехе (иначе `skipped: fields_failed`); нет
    набора — нет шага и вызовов. Конвейер: `assertWriteChannel` → свежее `videos.list snippet,localizations` (должно уже
    показывать значения полей) → `checkDefaultLanguage` → собственный язык видео в наборе = отказ → бэкап → трансляция всё ещё
    текущая и повторное чтение без изменений (иначе ничего не отправляется) → общее слияние (язык звука отправляется как прочитан,
    `zxx` тоже) → `assertLiveWritesAuthorized` → `videos.update` → проверка чтением (записанные языки, остальные языки не потеряны,
    теги/категория/языки не изменились) → аудит. Пробные расчёты: +53 единицы.
  - Этап 4: MCP `factory_live_save_localizations` (Factory API 1.27.0, локальная запись, проход через device mutation gate,
    нет трансляции — `live_stream_not_found`) и `factory_live_get_status.localizations` (набор, предупреждения, последний шаг —
    коды); маршрут `GET/PUT /api/channels/[channelId]/live-stream/localizations` и поле `localizations` в обзоре трансляции.
    Набор без сохранённых настроек видео — предупреждение `video_settings_not_saved`, не отказ (владелец, msg 3287); набор с
    нынешним основным языком канала — `baseline_language_in_set`, канал без основного языка — `no_baseline` (тоже предупреждения).
  - Этап 5: карточка «Переводы» (`src/components/live-stream-localizations.tsx`, логика —
    `live-stream-localizations-model.ts`) под настройками трансляции: строка на язык (язык, название, описание), добавить /
    убрать / сохранить, отказы сервера по строкам, предупреждение и результат последнего шага; шаг `localizations` в списках шагов.
- **BL-210 переводы самого канала (`docs/roadmap/plans/CHANNEL_LOCALIZATIONS_PLAN.md`, ADR 0047, ветка
  `feature/channel-localizations`):**
  - Третий разрешённый писатель `localizations` (`docs/WRITE_AUTHORIZATIONS.md`) — модуль `src/lib/channel-localizations/`: название и описание
    канала на других языках (`channels.localizations`).
  - Схема **v104** (только этот компьютер): `channel_localizations` (набор на канал, кто сохранил, последний результат) и
    `channel_localization_events` (журнал аудита).
  - `set.ts` (чистый): валидатор через общий `shared-localization-set` (название 1–30 символов, описание 1–1000 символов —
    документированные пределы полей канала), предпросмотр (new / changed / unchanged, нетронутые языки, установка языка по
    умолчанию, квота).
  - «Применить» только из Web UI (`POST /api/channels/[channelId]/channel-localizations/apply`, тело `{ setVersion }` из
    предпросмотра): набор не менялся после проверки (иначе `localizations_changed`) → `assertWriteChannel` → свежее
    `channels.list` → отказы `channel_default_language_not_set` (нет `brandingSettings.channel.defaultLanguage` — владелец задаёт
    его в YouTube Studio, msg 3350) / `default_language_mismatch` / `own_language_in_live` / свой язык в наборе → бэкап →
    повторное чтение → общее слияние (запись своего языка, равная базовому тексту, отправляется без изменений) →
    `assertLiveWritesAuthorized` → один `channels.update part=localizations` → проверка чтением → аудит. 50 единиц плюс чтения.
    `brandingSettings` этот писатель не пишет (их пишет только BL-223, ADR 0050).
  - Шлюзы: `getChannelLocalizationsContext` (чтение), `updateChannelLocalizations` (запись).
  - MCP Оператора (Factory API 1.29.0): `factory_channel_save_localizations` (локальная запись) и
    `factory_channel_get_localizations` (набор, переводы на YouTube — 1 единица, последний результат в кодах); маршрут MCP получает
    только поверхность без apply (AC-CL-10).
  - Карточка «Переводы канала» (`src/components/channel-localizations-panel.tsx`) во вкладке «Языки» под настройками языка канала
    и (BL-223) на «Главной» под карточкой «Канал».
- **BL-223 оформление канала (`docs/roadmap/plans/CHANNEL_BRANDING_PLAN.md`, ADR 0050, ветка `feature/bl-223-channel-branding`):**
  - Разрешённый писатель `brandingSettings` (`docs/WRITE_AUTHORIZATIONS.md`, владелец msgs 3482/3488) — модуль `src/lib/channel-branding/`:
    описание, ключевые слова и баннер канала; название и аватар только показываются (API их не меняет).
  - Схема **v109** (только этот компьютер): `channel_branding` (черновик на канал, кто сохранил, последний результат) и
    `channel_branding_events` (аудит). Баннер копируется в `<данные приложения>/channel-branding/<channelId>/banner.<jpg|png>`.
  - `draft.ts` (чистый, его же берёт карточка): пределы (описание 1000 символов, ключевые слова 500, баннер jpeg/png ≤ 6 МБ,
    ≥ 2048×1152, ровно 16:9), размер картинки из заголовка PNG/JPEG без зависимостей, ключевые слова в формате YouTube.
  - «Применить» только из Web UI (`POST /api/channels/[channelId]/channel-branding/apply`, `{ draftVersion }`): `branding_changed`
    → `assertWriteChannel` → чтение → бэкап → повторное чтение → `channelBanners.insert` → полный `brandingSettings`
    (`channels.update`), Live writes перед каждой записью → проверка чтением → аудит; `banner_uploaded_not_set`,
    `read_back_mismatch`.
  - Шлюзы: `getChannelBrandingContext` (чтение), `insertChannelBanner` и `updateChannelBrandingSettings` (запись).
  - MCP: `factory_channel_get_branding` / `factory_channel_save_branding` (Factory API 1.32.0) и `agent_channel_get_branding` /
    `agent_channel_save_branding` у работника своего канала (Agent API 4.6.0); баннер агента — путь в `Sent to YTM`. Apply нет ни
    в одном MCP-пути (AC-CB-09).
  - Карточка «Канал» (`src/components/channel-branding-panel.tsx`) на «Главной», под ней «Переводы канала».
- **BL-225 план недели публикаций (`docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md`, ADR 0051, ветка `feature/bl-225-weekly-plan`; этап 1):**
  - Модуль `src/lib/publishing-plans/` (§M: только семейство синхронизации, подключения каналов, `zoned-time`; не `publishing`).
    План на канал и неделю (понедельник), часовой пояс канала в плане, слоты `{ slotId, date, publishAt (местное), lengthHint,
    note }`. Одобрение, «изменён после одобрения», вето и статус выводятся из записей, не хранятся.
  - Хранение: семейство синхронизации `publishing_plans` (19-е; документ Automerge на канал, `<данные приложения>/publishing-plans-doc`),
    одинаково на обоих компьютерах. Схема БД не меняется.
  - MCP: `factory_publishing_plan_save/get/list` (Factory API 1.33.0) и `agent_publishing_plan_save/get/list` у работника своего
    канала (Agent API 4.7.0). Решений в MCP нет (AC-WP-05): одобряет, отзывает, снимает и возвращает только владелец.
  - Маршруты владельца `/api/channels/[channelId]/publishing-plans` (+ `/[weekStart]`, `/[weekStart]/decisions`); аудит решений на
    этом компьютере. Вкладка Контент → «План недели» (`src/components/weekly-plan-panel.tsx`, чистая часть `weekly-plan-model.ts`)
    со значком «ждёт одобрения»; «Всю неделю / По одному» — вид, не настройка.
  - Этап 2: пакет `yt-release-package/2` (`slotId`, `localizations`, `containsSyntheticMedia`, `thumbnails` с одной основной; 2 МБ на
    каждую обложку — при сканировании и в «Новом пакете»); схема **v110** `publishing_uploads.slot_id`; модуль-композиция
    `src/lib/publishing-plan-progress/` (скан пакетов и строки загрузок этого компьютера → статусы слотов и данные пакета на экране).
    BL-270: скан канала держится минуту, затем до 5 минут — пока совпадает дешёвый отпечаток (`packageScanSignature`: файлы
    `04 Videos/` с размером и mtime, список удалённых, время синхронизации копии, поля строк `videos` канала, которые читает скан —
    так видна и запись `video-details` в локальную копию) и отпечаток файлов, которые скан нашёл по манифестам (`packageScanFilesSignature`:
    через симлинки и глубже обхода, `src/lib/publishing/scan-signature.ts`); правленый манифест, перерендер или вето видны при следующем чтении.
  - BL-240 (ADR 0060): снятые слоты свёрнуты в строку «Снятые слоты: N»; агент может удалить снятый слот без загрузки (вето
    остаётся для загрузок, id занят — `slot_id_removed`); поле слота `replacesSlotId` — одобрение владельцем нового слота тем же
    решением снимает заменённый (`replacedBy`). Factory API 1.41.0, Agent API 4.15.0.
  - BL-242 (ADR 0062): этап одобрения канала `approvalStage` в документе планов (`packaged` по умолчанию, `slot` — поведение BL-225;
    ставит только владелец тумблером «Одобрять пустые слоты», маршрут `/publishing-plans/approval-stage`, аудит
    `publishing_plan.approval_stage`). В `packaged` слот без готового/загруженного пакета — `awaiting_package` (план `planned`),
    одобрение — хеш слота с отпечатком пакета `[video, manifestSha256, videoId|null]`, решение хранит отпечаток; загрузки
    (`src/lib/publishing/slot-decision.ts`) дают дату только одобренному манифесту, план-расписание находит загрузку по video id
    одобрения (слот берёт уже загруженное видео через `slotId` пакета). Factory API 1.42.0, Agent API 4.16.0, Producer API 1.16.0.
  - BL-243 (ADR 0063): удалённый на YouTube пакет не держит слот, говорит за слот, только если других пакетов у слота нет
    (`failed` + `video_deleted_on_youtube`, «Ролик удалён на YouTube»), одобрять нечего, прежнее одобрение не считается;
    план-расписание не трогает удалённые видео. Агентам: `missingOnChannel` в календаре, `videoIds` в `channel_video_list`.
    Factory API 1.43.0, Agent API 4.17.0, Producer API 1.17.0.
  - BL-256 (ADR 0051 Amendment 1): владелец переносит слот на другой день недели и/или время («Изменить время» в строке слота,
    маршрут `/publishing-plans/[weekStart]/retime`, `retime()` в модуле): не снятый, не прошедший, не ближе 15 минут; старое
    одобрение отзывается, «Сохранить и одобрить» одобряет новое время тем же шагом — дату загруженного видео на YouTube переносит
    цикл plan-schedule. `updatedBy: owner`; аудит `publishing_plan.retimed`. Factory API 1.47.0, Agent API 4.20.0. **BL-267 (ревью):
    маршрут `retime` и `retime()` удалены — их заменил перенос `move()` (сначала YouTube, потом план).**
  - BL-263 (PRD-REQ-0194, owner TG 2332/2334/4553/4555, ADR 0071, `docs/roadmap/plans/SHORT_VIDEO_CODE_PLAN.md`) — **на ветке
    `feature/bl-263-short-video-code`, не влито в `dev`**: второй код видео `S<n>` для шортсов WWE. Общий модуль
    `src/lib/shared-video-code/` (§M, без зависимостей) — единственное место правил кода: строгий `^(V|S)[1-9][0-9]{0,5}$` для ввода,
    читатели файлов и отчётов сохраняют свой мягкий V (`V\d+`) и добавляют строгий S, сравнение (V перед S, по числу), версия отчёта.
    Сканер пакетов читает папки `<MMDD> S<n> Short` и `S<n>_release.json` (S-пакет, чей `video` не совпадает с папкой, — `field_invalid`).
    Нумерация (`video-projects`): следующий V = наибольший V + 1, S не считаются; `factory_video_create.video` резервирует данный код S
    (`video_number_taken`); конфликт S без перенумерации; псевдоним перекодировки — V, отменённый с `replacedBy` S, показывается
    `recoded` (затраты под S, одобрение слота с тем же videoId покрывает пакет S). Отчёты `publishing-uploads`, `video-reservations`,
    `video-costs` — версия 2 только с кодом S. `factory_release_recode` (Factory API 1.49.0; `src/lib/publishing/release-recode.ts`,
    подключение `src/composition/release-recode.ts`, строки — `db.ts` `snapshotVideoRecodeRows` / `recodeVideoRows` /
    `undoVideoRecodeRows`): разовая локальная перекодировка шортса V → S — файлы по имени кода (целым токеном), манифест (только
    `video` и файловые поля), записи, папка, строки этого компьютера одной транзакцией, раскадровки; журнал с копиями, откат при сбое,
    восстановление после падения (законченный журнал `completed` только удаляется, не откатывается; незаконченный блокирует коды
    S/V и виден в `pendingRecodes`, модуль `src/lib/release-recode-journals/`); без вызова YouTube. Предусловие: оба компьютера на
    этой сборке до первого настоящего запуска. Agent API 4.21.0, Producer API 1.23.0. С Factory API 1.50.0 (owner TG 4584) одобрение
    пакета владельцем больше не отказ: последнее решение владельца (одобрено / возвращено с комментарием) по старому SHA-256 манифеста
    копируется на новый до любых изменений (`carryReviewDecisionForRecode` модуля `package-reviews`, поле `carriedFrom`, исходное
    время), результат `review: { carried }`; нечитаемый документ проверки — `release_recode_busy` `review_carry_failed`.
  - BL-261 (owner TG 3521 через Оператора): `factory_release_folder_rename` (Factory API 1.48.0) — переименование папки пакета в
    `04 Videos/<месяц>/` (`src/lib/publishing/release-folder-rename.ts`, подключение `src/composition/release-folder-rename.ts`): имя
    должно содержать номер видео; папка переезжает целиком, строки загрузок этого компьютера (очередь и законченные) переписываются
    одной транзакцией (`manifest_path` и пути в `package_json`), при сбое папка возвращается; отказ, пока видео отправляется /
    обрабатывается / завершается / на паузе здесь, не закончено на другом компьютере или кросс-пост грузит файл; сверка и аудит.
  - BL-259 (owner msg 4397): значок формата видео (вертикальное / горизонтальное) на «Роликах и релизах» (доска и пакеты), в «Плане
    недели» и календаре (`src/components/orientation-icon.tsx`). Источник — ширина и высота из того же вызова ffprobe, что и длительность
    при сканировании пакета (`probeFrame`, поле `orientation` пакета и `PlanSlotPackage`); прочитанное запоминается на этом компьютере
    по номеру видео (`app_settings.video_orientations`), так что значок остаётся после удаления mp4. Неизвестно — значка нет.
  - BL-260 (owner msg 4421): всплывающий плеер «▶» в «Плане недели», календаре (список дня) и на «Роликах и релизах» (доска и
    пакеты) — `src/components/video-popup.tsx`: сначала mp4 пакета с этого компьютера через маршрут `package-reviews/video` (по SHA-256
    манифеста, HTTP Range, только браузер владельца), если файла нет — плеер YouTube (youtube-nocookie) по video id и ссылка на ролик.
  - Этап 3: автозагрузка (BL-209) ставит пакет одобренного и не снятого слота с его временем, снятый пропускает (решения слотов —
    `src/composition/publishing-plan-slots.ts`); загрузчик пишет переводы пакета первым шагом после обработки общим писателем
    `src/lib/shared-video-localizations/` (вынесен из live-localizations) и ИИ-метку пакета; дата — только после переводов, обложки,
    плейлиста и сверки. Цикл `plan-schedule` (раз в минуту, `instrumentation.ts`): вето снимает дату у загруженного видео, одобрение
    или новое время её ставит — через video-details (`publishAt: null`). Статусы загрузки видны только на загружающем компьютере.
- **Общий модуль `src/lib/shared-localization-set/`** (BL-210, §M): валидатор набора «язык → название/описание» с пределами
  параметром; им пользуются `live-streams/localizations.ts` (пределы видео) и `channel-localizations` (пределы канала).
- **Общий модуль `src/lib/shared-localization-merge/`** (BL-207, §M): `buildSafeLocalizationsPayload`, `checkDefaultLanguage`,
  `localeKeyFor` — вынесены из `batches/merge.ts` (тот реэкспортирует); им пользуются Batches и `live-localizations`.
  BL-226: `untitledTranslations` — правило «перевод без названия» (YouTube отклоняет всё видео: «The request metadata is
  invalid.»). Одно правило для экрана набора (`getChangeSet.untitledTranslations`), отправки (`planSendTogether.untitled`, отказ
  `send_untitled_translations`) и самой записи (`buildSafeLocalizationsPayload` бросает до `videos.update`).
- **Общий модуль `src/lib/youtube-video-fields/`** (BL-186, §M): лимиты и списки полей видео (500 символов тегов, 2 МБ обложки,
  категории, лицензии, тип картинки по байтам, `hasAngleBrackets` — BL-207); публикация реэкспортирует их без изменений.
- **Риски:** RISK-125 (ключ в командной строке ffmpeg), RISK-126 (T9 нужен раз в ~2 ч).

