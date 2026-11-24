> Moved verbatim from SYSTEM_MAP.md §2 on 2026-11-17; index: ../SYSTEM_MAP.md

### 2.9an Публикация из YT Manager: загрузка, календарь, напоминание (BL-182, FO-REQ-0023, ADR 0037, `docs/roadmap/plans/PUBLISHING_PLAN.md`) — **этапы 0–1 IMPLEMENTED, влиты в `dev` 2026-10-13; этап 2 IMPLEMENTED, влит в `dev` 2026-10-13 (`3ad95cc`), первая настоящая загрузка ещё не проводилась; этап 3 впереди**

- **Этап 0 (G1).**
  - Возобновляемая загрузка и `deleteVideoById` в шлюзе записи (`youtube-write-gateway/upload.ts`).
  - Своя дневная корзина квоты `videos.insert` (100 вызовов).
  - Проба G1 (`publishing/g1-probe.ts`, CLI только для разработчика `npm run cli:publishing-g1`).
  - Результат 13.10: загрузки не блокируются. `defaultAudioLanguage` принимается. «AI use» ставится, но API его не отдаёт.
- **Этап 1.**
  - Контент → «Календарь»: месячная сетка, покрытие, пустые дни, без даты и с прошедшей датой.
  - «Запланировано» в «Видео».
  - Напоминание «меньше 7 дней»: значок «Контент» и раздел «Публикации» в колокольчике.
  - Перенос даты приватного запланированного видео (`video-details/publish-at-rule.ts`).
  - `agent_get_publishing_calendar` (Agent API 3.16.0, Producer API 1.7.0).
  - Опрос раз в минуту только локальный. Другие каналы обновляются при загрузке дашборда, если данные старше 6 ч.
- **Этап 2** (`docs/ARCHITECTURE.md` §47.3).
  - Общие теги канала (`channelTags`, FO-MSG-0017 / BL-190): пакет с `tags: []` получает теги канала, с непустыми — только свои (сообщение владельца 2817, вариант «б»); окно подтверждения показывает теги каждой строки и их источник; тег с `<`/`>` в пакете — проблема `tags_angle_brackets`.
  - Дефолты публикации канала: `publishing/settings.ts`, семейство синхронизации `channel-publishing-settings` (документ на
    канал), конфликты в «Слиянии»; Настройки → Каналы (до BL-266 — Контент → «Публикация»), время — `UtcTimeField` (12:00 UTC по умолчанию).
  - Пакеты релизов: `publishing/packages.ts`, `package-scan.ts` (`04 Videos/**/V*_release.json`, проверки по правилам YouTube,
    состояние по `Vn_youtube.json`; обход и чтения — общий `src/lib/workspace-videos/`, BL-187). BL-243 (ADR 0063): состояние
    `deleted_on_youtube` — видео записи помечено синхронизацией удалённым (`removed_on_youtube_at`); `uploaded_unknown` — его нет
    в копии; у каждого пакета `existsOnChannel` и `checkedAt` (время завершённой проверки удалений — `channels.removed_check_at`,
    схема v118).
  - Подтверждение: `upload-approval.ts` (хеш манифеста и показанные настройки, квота: корзина `videos.insert` 100 в день и
    `quota-guard.checkUnits`, другой компьютер — семейство `publishing-uploads`).
  - Загрузка: `upload-runner.ts`, таблица `publishing_uploads` (схема v89, только этот компьютер), цикл раз в 5 с в
    `instrumentation.ts`; примитив `setVideoThumbnail` в шлюзе записи. Порядок (сообщения владельца 3510/3511, FO-REQ-0040 п. 4):
    вставка private без `publishAt` → обработка → превью → плейлист → сверка → только потом дата (с чтением после записи); если
    превью, плейлист или сверка не удались — дата не ставится (`steps.publishAt = "withheld"`), видео остаётся private без даты.
  - API: `/api/channels/[id]/publishing-settings(/conflicts)`, `/publishing/packages(/thumbnail)`, `/publishing/uploads(/[uploadId]/cancel|/move)`.
  - Агенты: `agent_get_publishing_calendar` отдаёт пакеты и загрузки (Agent API 3.17.0, Producer API 1.8.0); у работников каналов и фабрики инструментов загрузки нет.
  - **Управление очередью (BL-239, ADR 0059, `docs/roadmap/plans/UPLOAD_QUEUE_CONTROL_PLAN.md`; `docs/ARCHITECTURE.md` §47.7):** одна очередь этого компьютера на все каналы; queued-строки стартуют по месту (`queue_rank`, схема v117, затем возраст), идущая загрузка не прерывается. `publishing/upload-queue-control.ts` (`createUploadQueueControlCore`): список, перемещение, отмена только `queued`, добавление Продюсером (только при включённом переключателе автозагрузки здесь; та же проверка пакета `checkPackageForQueue`, что у автозагрузки; `queueByProducer`; private, дата только из одобренного слота; одна попытка на версию манифеста, кроме строк, которые Продюсер сам поставил и сам отменил; слот, переставший быть одобренным, снимает дату и у строки Продюсера). Аудит с `by` (producer/owner); `queued_by` у строки. Producer API 1.14.0: `producer_upload_queue_list/_add/_move/_cancel` (producer-only). Владелец: стрелки ↑↓ и место «№ k из n» в списке загрузок (`POST .../uploads/[uploadId]/move`).
  - **Остановка идущей загрузки (BL-244, ADR 0064):** `cancel` очереди — единственная отмена для Продюсера и владельца; останавливает и `uploading`/`paused` до последнего куска одним условным `UPDATE` (`stopPublishingUploadBeforeYoutube`: нет `video_id`, нет `finalChunkSentAt`), который либо опережает отметку последнего куска раннером, либо получает отказ `upload_not_cancellable` (`reason: final_chunk_sent`). Аренда (`claimPublishingUpload`) только у активной строки. Без вызова YouTube (сессия истекает сама). Producer API 1.18.0; в Web UI «Остановить загрузку» с подтверждением.
  - **Автоматическая загрузка private (BL-209, ADR 0046, `docs/roadmap/plans/AUTO_PRIVATE_UPLOAD_PLAN.md`; `docs/ARCHITECTURE.md` §47.5):** переключатель `autoPrivateUploadEnabled` (`app_settings`, по умолчанию выключен, на этом компьютере, на карточке Live writes; ставится только через `/api/settings`). `publishing/auto-upload.ts`, свой цикл раз в 5 мин в `instrumentation.ts`: готовый пакет с `sha256` в манифесте, размер и SHA-256 видео совпадают (хеш — только при совпавшем размере, кеш по хешу манифеста, размеру и mtime), не занят здесь и другим компьютером, для этой версии манифеста здесь ещё нет ни одной строки загрузки (автоматической или ручной, любой статус) → `upload-approval.ts` `queueAutomatic` (те же проверки, что у одобрения; без даты, private). Схема v103: `publishing_uploads.automatic`. Строка помечена «автоматически»; `agent_get_publishing_calendar` — `automatic`, `progressPercent`, `finishedAt` (Agent API 3.20.0, Producer API 1.10.0). Инструментов агентов нет. Включать только на одном компьютере; перед новой сессией раннер заново сверяет SHA-256 видео (`video_hash_mismatch`).
  - **Свой пакет владельца (BL-192, `docs/roadmap/plans/NEW_RELEASE_PACKAGE_PLAN.md`) — влито в `dev` (`c16be6c`):** «Новый пакет» в «Публикации». `publishing/package-composer.ts` перечисляет папки `04 Videos/<месяц>/<ММДД Vn>` с видео; из выбранной папки берёт видео, `Thumbnail_*`, название и описание из `*Title_Description*.txt` (строки `TITLE` / `DESCRIPTION`), размер, длительность ffprobe и базовые языки канала; показывает проверки пакета; сохраняет `Vn_release.json` (атомарно, только внутри реальной `04 Videos`, `createdBy: "owner"`). Замена — только пока ролик не загружен и не в очереди здесь или на другом компьютере (то же правило, что у одобрения). Маршруты `GET .../publishing/package-folders`, `POST .../publishing/package-draft`, `POST .../publishing/package`. На YouTube ничего не уходит; новых инструментов агентов нет.

- **BL-235 одно покрытие дней публикации (сообщения владельца 3806/3807, ветка `feature/bl-235-coverage`; `docs/ARCHITECTURE.md` §47.6):**
  - Общий модуль `src/lib/publishing-coverage/` (§M, без модулей-фич): день (дата в поясе канала) `covered` — видео опубликовано
    (публичное), запланировано или «время прошло, ещё не синхронизировано» (меньше 24 ч) на этот день и у него все отслеживаемые переводы (правило «Языков», `shared-language-baseline.missingTrackedLanguages`);
    `missing_translations` — видео есть, переводов не хватает; `gap` — нет (просроченное ≥ 24 ч, без даты, по ссылке, запись эфира приложения, эфир не закрывают). `asOf` —
    последняя синхронизация канала. Правило видео календаря перенесено сюда (`rules.ts`).
  - Пояс канала: пояс его последнего плана недели, иначе пояс владельца, иначе UTC (`src/composition/publishing-coverage.ts`).
  - «Календарь»: клетки — дни канала, пустые дни и жёлтые «без всех переводов» — из покрытия; напоминание, значок и колокольчик: due =
    закрыто подряд меньше 7 дней. «План недели»: строка «Закрыто N из 7 · без видео · без переводов» (одобрения не меняются).
  - MCP (только чтение): `factory_publishing_coverage` (Factory API 1.39.0), `agent_publishing_coverage` (Agent API 4.13.0);
    `agent_get_publishing_calendar` — `coverage.due`, `gapDates`, `missingTranslationDates` по тому же правилу (Producer API 1.13.0).
    Пояс канала кешируется на 5 мин.

### 2.9bc «Собрать неделю»: сборка недели фабрики из Web UI (BL-231, FO-REQ-0046, `docs/roadmap/plans/WEEKLY_BUILD_BUTTON_PLAN.md`, ADR 0055) — **IMPLEMENTED на ветке `feature/bl-231-build-week-button`, не влито; приёмка — после перевода каналов на пакет 2.5.42**

- **Модуль `src/lib/weekly-build/`** (§M; только `channel-workspaces` и `local-path-validation`): запускает запускатор канала
  `<рабочая папка>/06 Workflows/factory_launch.py` (`check`, `13 status --json`, `auto --dry-run --json`, `start … auto [--wake]
  --json`, `stop`, `go`) Python этого компьютера через `execFile` без оболочки, с минимальным окружением (`host.ts`), и читает JSON.
  Перед каждым запуском: запускатор — файл внутри папки, пакет ≥ 2.5.42 в `factory.json`, `check` прошёл (кэш 5 мин). Своих
  записей нет; план в Manager по-прежнему присылает работник канала (`13 push`).
- **Настройка:** путь к Python — `app_settings.weekly_build_settings` (`/api/weekly-build/settings`); пусто — обычные папки, потом PATH.
- **Маршруты владельца** `/api/channels/[channelId]/weekly-build` (GET), `/dry-run`, `/start`, `/stop` (POST); MCP-инструмента нет
  (`no-agent.test.ts`). Ошибки: `weekly_build_unavailable` (409, `details.code`), `weekly_build_job_running` (409), `weekly_build_failed` (502).
- **Web (до BL-267; карточка `weekly-build-card.tsx` удалена на ревью BL-267, её заменила «Собрать неделю по шаблону» —
  `weekly-template-build-card.tsx`; маршруты ниже остались):** карточка «Сборка недели» над планом: календарь
  дат (завтра … +28, только отмеченные; `auto --dates`, перед запуском всегда пробный прогон, отказ фабрики `bad_dates` →
  `weekly_build_bad_dates` 422 с причиной по дате), «Собрать N дней» → подтверждение с пробным прогоном, ход и «Стоп», таблица слотов с проблемами, «Нужна упаковка» →
  «Разбудить агента» (`auto --wake`). Задача отсоединена запускатором: перезапуск сервера её не останавливает.
- **Риск:** RISK-138.

### 2.9bf Удаление локального mp4 после загрузки (BL-238, FO-REQ-0051, ADR 0058, этап 1 — новые загрузки) — **IMPLEMENTED на ветке `feature/fo-req-0051-local-video-cleanup`, не влито**

- **Модуль:** `src/lib/local-video-cleanup/` (§M: его никто не импортирует; строки загрузок и ротаций читает через `db.ts`). Единственный код, который удаляет файл релиза канала.
- **Что удаляется:** только `04 Videos/<MM> <EnglishMonth>/<MMDD> V<n>/V<n> <канал>.mp4` самой загрузки (`allowlist.ts`, имя канала — папка без номера). Каждый компонент проверяется `lstat`: без symlink, папки до конца, в конце обычный файл. Больше ничего (папки сборки чистит сам бандл).
- **Когда:** цикл в `instrumentation.ts`: через 3 мин после старта, затем раз в 30 мин; ждёт при блокировке операции и в режиме восстановления. Берутся загрузки этого компьютера `done`, закончившиеся после включения переключателя (`enabledAt`).
  - Сначала локальные проверки: путь; файл; размер = загруженному; нет в ротации эфира и в активной загрузке.
  - Затем `videos.list status,processingDetails,fileDetails,contentDetails` (1 ед. на 50 видео, read gateway `getVideosCleanupState`): обработано; публичное или private с `publishAt`; `fileDetails.fileSize` = локальному (иначе длительность ffprobe ±2 с).
  - Затем sha256 из пакета, если он есть.
- **Удаление:** метка `….mp4.deleted.json` (`deleted-video/1`, контракт Оператора) пишется через tmp + fsync + rename, затем перечитывается; только после этого unlink. Перед unlink повторно проверяются allowlist, dev/inode/размер и метка.
- **Журнал:** «ждёт» не пишется и проверяется снова. «Отказ» и «удалён» пишутся один раз на загрузку в `local_video_cleanup_log` (v116, device-local) и строкой в `99 Data Exchange/From YTM/cleanup-log.csv`.
- **Переключатель:** `app_settings.local_video_cleanup_settings`, на канал и компьютер, по умолчанию вкл. (сообщение владельца 3900: с первой проверки, старые загрузки не трогаются; «выкл.» владельца сохраняется), не синхронизируется. UI: карточка в Настройки → Каналы (до BL-266 — Контент → Публикация; `LocalVideoCleanupCard`, своя `FeatureErrorBoundary`): переключатель с подтверждением, освобождено ГБ, ожидают, последние удаления/отказы. Маршрут `GET/PUT /api/channels/[channelId]/local-video-cleanup`; MCP-инструмента нет.
- **Не в этом этапе:** очистка старых видео кнопкой владельца, предпросмотр `factory_cleanup_preview`, видео, загруженные не через YT Manager (вариант Б).

### 2.9bl Проверка владельцем итогового пакета (BL-257, owner msgs 4514/4516/4519, ADR 0070, `docs/roadmap/plans/PACKAGE_REVIEW_PLAN.md`) — **IMPLEMENTED на ветке** `feature/bl-257-package-review` (ждёт ревью и разрешения на мердж)

- **Модуль:** `src/lib/package-reviews/` (§M: без других фич, Google и сети; пакеты канала и их файлы даёт слой композиции
  `src/composition/package-reviews.ts` из скана `publishing`). Решающее — ПОСЛЕДНЕЕ решение владельца по SHA-256 манифеста (до загрузки
  можно передумать); одобрение покрывает манифест и SHA-256 файла обложки; отказ без `sha256` видео в манифесте и если mp4 этого
  компьютера не совпадает с ним. Возврат — только с комментарием.
- **Хранение:** семейство синхронизации `package_reviews` (документ Automerge на канал, `<данные приложения>/package-reviews-doc`,
  подпапка Syncthing `package-reviews`): переключатель `required` и решения. Нет документа — ворот нет; документ не читается — всё ждёт.
  Схема БД не меняется.
- **Ворота:** `publishing/package-scan.ts` (порт `ownerReview`, читается раз за скан): неотправленный пакет без других проблем получает
  `owner_review_pending` / `owner_review_returned` и становится `not_ready` для плана недели, автозагрузки, `producer_upload_queue_add` и
  одобрения загрузки. Канал без ворот сканируется как раньше. Исключение «tried»: одобренный манифест, чьи строки загрузки все отменены без
  `video_id` и созданы до одобрения, автозагрузка берёт снова (только пока ворота включены). Загрузчик перед стартом строки в очереди
  проверяет ревью снова: не покрытая одобрением строка отменяется `owner_review_withdrawn` до первого байта. Порядок решений — `seq`
  документа, затем время (RISK-154). При выключенных воротах вкладка ничего не считает ждущим.
- **Владелец:** маршруты `/api/channels/[channelId]/package-reviews` (+ `/decision`, `/video`, `/thumbnail` — HTTP Range, браузер владельца,
  в т.ч. телефон через удалённый доступ). Вкладка Медиа → «Видео на проверку» (`/media/packages`, `src/components/package-reviews-panel.tsx`):
  переключатель, плеер, обложка, тексты, языки, слот, «Одобрить»/«Вернуть» в диалоге; на телефоне — липкая панель действий. Решение
  сбрасывает кэш пакетов плана; слот плана пишет «ждёт вашей проверки в Медиа» / «возвращено: …».
- **Агенты:** только читают коды проблем (Producer API 1.21.0, Agent API 4.19.0, Factory API 1.46.0); файл пробуждения Продюсера
  `REVIEW-DECISION-package-<video>-<decisionId>.md`. Ни один MCP-путь не решает и не переключает (`package-reviews/boundaries.test.ts`).
  Это не писатель YouTube.

### 2.9bn Шаблон недели вместо одобрения слотов (BL-267, PRD-REQ-0195 A, ADR 0073, `docs/roadmap/plans/WEEK_TEMPLATE_PLAN.md`) — **IMPLEMENTED на ветке** `feature/bl-267-week-template` (ждёт ревью, текст §F у владельца, разрешения на мердж)

- **Шаблон:** `publishing-plans/template.ts` (`week-template/1`: дни `mon..sun`, `kind long|short`, `hours?`, `publishTimeUtc`;
  `horizonWeeks`, `displayTimeZone` только для показа), хранение в семействе `publishing_plans` — карты `templateVersions` (неизменяемые
  версии) и `templateDecisions` (решения владельца), не в генезисе, чтение через конфликт первой записи. «В силе» — новейшее решение
  владельца approved/withdrawn с совпадающим хэшем; иначе нет (fail closed). Службы `template-services.ts`: правка владельца (версия +
  одобрение одним изменением), принять/отклонить, снять — только Web UI; предложение — Продюсер.
- **Сопоставление:** UTC-день и точная минута; short ≤ 180 с, `hours` ±10 %, S-код длиннее 180 с — неясный вид; одна позиция = первый
  созданный слот этого вида (O4), long и short раздельно.
- **Правило даты** (`slotDecisions`, `source: template | owner`): совпал + упаковка готова/загружена + медиа одобрено (на канале с
  проверкой; сведения о медиа — порт `progress`, `publishing-plan-progress` по правилу `package-reviews`); явная дата — один слот.
  Привязка к медиа (`approvalNamesUpload`, `fingerprintCovers`). `approvalStage` и замена (`replacesSlotId`) больше ничего не решают.
  Соцсети (`socialSlotStates`) следуют тому же датированию (O10).
- **Своя дата** (`publishing/plan-schedule.ts`): автоматический проход не двигает и не снимает дату, поставленную не этим компьютером
  (`planSync.result: foreign_date`); явный перенос (`explicitPrecheck` / `explicitMove`, тот же `change()` в явном режиме) — может.
- **Перенос** (`publishing-plans` `move()`): владелец (маршрут `/publishing-plans/move`) и Продюсер (`producer_publishing_plan_move_slot`)
  — куда угодно, id сохраняется, одно изменение `moveSlot`, `movedFrom`; дата на YouTube пишется сразу через порт `moveYoutube`
  (`src/composition/publishing-plan-moves.ts` → `publishing.createPlanMoveYoutubeCore`); первую дату не даёт.
- **Экран:** «План» (Неделя | Месяц | Шаблон недели, `week-template-editor.tsx`, `week-template-model.ts`), «Календарь» убран,
  «Собрать неделю по шаблону» (`weekly-template-build-card.tsx`, `composition/weekly-build-template.ts`, weekly-build `startByTemplate` /
  `collectTemplateBuild`, файл `05 Docs/publishing/week-template.json`).
- **Контракты:** Factory 1.52.0 (`factory_publishing_template_get`), Agent 4.23.0 (`agent_publishing_template_get`), Producer 1.25.0
  (`producer_week_template_get` / `_propose`, `producer_publishing_plan_get` / `_list` / `_move_slot`, разрешение `PLAN_MOVE`).

### 2.9bm Ворота только по медиа и правка упаковки после загрузки (BL-265, PRD-REQ-0195 B, ADR 0072, `docs/roadmap/plans/MEDIA_GATE_PLAN.md`) — **IMPLEMENTED на ветке** `feature/bl-265-media-gate` (ждёт ревью и разрешения на мердж)

- **Ворота по медиа:** решение владельца (`package-reviews/model.ts`, `standingDecision`) покрывает mp4 — `videoSha256` + `videoSizeBytes`
  манифеста под кодом видео или его алиасом перекодировки BL-263 (порт `recodeAliases` из `video-projects`, только в композиции и
  `publishing/index.ts`); решение до BL-265 покрывает свой манифест (двойное чтение, без миграции). Один порядок для обоих видов.
  Обложка больше не часть одобрения. Новый вид `packaging_comment` (комментарий к упаковке) ворот не меняет и будит Продюсера.
  Перекодировка копирует только решение до BL-265; решение по mp4 идёт за алиасом без копии.
- **Только жёсткие пределы:** `packageChecks` → блокирующие `problems` и `warnings` (главы, тестовые обложки); `ScannedPackage.warnings`,
  календарь/план (Agent 4.22.0, Factory 1.51.0, Producer 1.24.0).
- **Очередь:** строка `queued` с замороженным `videoSha256` (теперь у каждой новой строки, и у одобрений владельца) берёт перепаковку
  только упаковки (`upload-runner.ts` `takeRepackage`: один раз читаемый манифест, тот же канал/видео/слот/mp4, без блокирующих проблем,
  ворота) — `steps.repackaged`, аудит `publishing.upload_package_refreshed`; другой mp4 → `media_changed`, другой слот →
  `package_slot_changed`, нечитаемый манифест ждёт до 10 мин. «Tried» — по ключу медиа (`triedKeysOf`).
- **Правка упаковки после загрузки:** `publishing/package-metadata.ts` (без нового писателя: `video-details.applyFieldsUpdate`) —
  название/описание/теги из текущего манифеста, тройная проверка, отказ при незавершённой загрузке; маршрут
  `/api/channels/[channelId]/publishing/package-metadata`, кнопки на строке загруженного пакета («План» → «⋯» → пакеты, и на карточке слота; до BL-266 — «Ролики и релизы»)
  (`package-packaging-actions.tsx`), инструмент Продюсера `producer_video_metadata_update` (конфликт — отказ). В `video-details`: Live writes
  прямо перед записью, `channelId` в снимке, `verifyUnchanged`, правило описания в сверке.

### 2.9bp Плейлисты из релиз-пакета (владелец, TG 4858/4859, поправка ADR 0051 от 2026-11-24) — **IMPLEMENTED на ветке** `feature/package-playlists` (ждёт ревью и разрешения на мердж)

- **Пакет:** `yt-release-package/2` — поле `playlists` (0–10 id по шаблону настроек `PLAYLIST_ID_PATTERN`, без повторов; v1 с полем —
  `field_invalid`), `packages.ts parsePlaylists`; строка загрузки замораживает список (`approved-package.ts`, `changedPackageFields`).
- **Шаг плейлиста** (`upload-runner.ts`): `playlistTargets` — плейлист настроек, затем плейлисты пакета, без дублей; по одному за
  проход (проверка канала перед каждой записью). Для плейлиста пакета — чтение владельца (`reads.playlistChannel`, `getPlaylistForUpdate`,
  1 ед.; нет читателя — `ownership_unchecked`), затем проверка наличия (`playlistContainsVideo`, 1 ед., вместо полного обхода), отметка
  `adding` до вставки, `inserted` после, чтение обратно (до READ_BACK_RETRIES повторов, без второй вставки). `steps.playlists`, аудит
  `publishing.upload_playlist`; `steps.playlist` — по-прежнему только плейлист настроек.
- **Правило даты:** неудачный плейлист настроек держит дату (как раньше, `plan-schedule.checksPassed` не менялся); неудачный плейлист
  пакета — нет, но строка `done` получает `step_failed` и заметку. Бюджет квоты: +53 ед. на плейлист пакета (`PACKAGE_PLAYLIST_UNITS`).
- **Чтение Продюсера:** `producer_video_playlists` (Producer 1.28.0), модуль `src/lib/video-playlist-membership/` (кэш 10 мин) +
  `publishing.listUploadPlaylistRecords` через композицию (`session-deps.ts`).
