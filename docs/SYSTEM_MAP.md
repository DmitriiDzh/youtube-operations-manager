# SYSTEM_MAP.md

Быстрая карта репозитория для коддинг-агентов (Claude Code), заходящих в проект впервые. Описывает систему **как она есть** после завершения Phase 4 (read-only синхронизация каналов/видео + Localization Manager read-only UI/XLSX export + XLSX import, draft state, change sets, diff/approval UI). Не описывает нереализованные фичи как существующие — см. раздел 4 про статус компонентов.

Это карта **девелоперской стороны** проекта (см. раздел B «Development / operations separation» в `AGENTS.md`). Будущий операционный агент (Codex) не читает этот документ и не обращается к этому репозиторию — он работает только с выпущенным релизом через MCP/API.

Каждый подраздел ниже помечен статусом: **IMPLEMENTED** (работает и покрыто тестами), **PLANNED** (осознанно запланировано, но не начато), **DEFERRED** (намеренно отложено с задокументированной причиной).

Смежные документы:

- `docs/PROJECT_SPEC.md` — продуктовый roadmap, модель безопасности записи, фазы.
- `docs/ROADMAP_STATUS.md` — журнал выполнения: какая фаза реально завершена, дата, коммит, следующее задание, открытые блокеры.
- `docs/ARCHITECTURE.md` — подробное описание архитектуры и её ограничений.
- `docs/DEVELOPMENT_PLAYBOOK.md` — практическое руководство «как расширять» эту архитектуру.
- `docs/TECHNICAL_DEBT.md` — реестр рисков и release-gates.
- `docs/decisions/` — ADR для значимых архитектурных решений.
- `docs/UPSTREAM_ANALYSIS.md` — анализ архитектуры унаследованного от TubeMaster кода (Phase 0).
- `docs/UPSTREAM_BASELINE.md` — верификация baseline (тесты/lint/build), состояние npm audit.

---

## 1. Общая схема потока данных

```text
User / Agent
    ↓
Web UI (dashboard) / CLI (video-metadata.ts) / MCP (server.ts) / API route handlers
    ↓
Domain Services (video-metadata, playlist-management, channel-sync)
    ↓
Auth (NextAuth / cli-auth) + Write-Context guardrail (только для write-путей)
    ↓
YouTube API Client (src/lib/youtube.ts, googleapis)         Database (src/lib/db.ts, SQLite/libSQL)
```

Все четыре интерфейса (Web/CLI/MCP/API) вызывают одни и те же core-фабрики (`createVideoMetadataCore()`, `createPlaylistManagementCore()`, `createChannelSyncCore()`) — ни один интерфейс не реализует свою собственную логику работы с YouTube API или свои проверки безопасности записи.

---

## 2. Подсистемы

### 2.1 Authentication / OAuth — **IMPLEMENTED**

- **Ответственность:** Google OAuth (веб-сессия через NextAuth + CLI/MCP через PKCE-loopback или device flow).
- **Файлы:** `src/lib/auth.ts` (`authOptions`, `YOUTUBE_SCOPES`, `buildGoogleLoopbackAuthUrl`, `startGoogleDeviceAuthorization`, `pollGoogleDeviceAuthorizationToken`, `exchangeGoogleAuthCode`, `revokeGoogleToken`), `src/app/api/auth/[...nextauth]/route.ts`.
- **Точки входа:** веб — `getServerSession(authOptions)` в каждом API route handler; CLI — `npm run cli:video-metadata -- auth login [--device]`.
- **Зависимости:** `src/lib/db.ts` (сохранение токенов в `users`).
- **Read/Write:** сама по себе не пишет в YouTube; получает/обновляет OAuth-токены.
- **Важные ограничения безопасности:** access/refresh токены никогда не логируются и не уходят в браузерный JS; хранение — только на сервере/локально.

### 2.2 Credential resolution — **IMPLEMENTED**

- **Ответственность:** превращение `CredentialRef` (`{ userId }` или явные токены) в `ResolvedCredentials` с проверкой достаточности OAuth-скоупов и автообновлением истёкшего access token.
- **Файлы:** `src/lib/video-metadata/adapters/google-auth.ts` (`resolveGoogleCredentials`, используется всеми доменными модулями, включая `channel-sync`), `src/lib/cli-auth/*` (для CLI/MCP: `service.ts`, `storage.ts` — файл `data/auth-context.json` с активным локальным пользователем, `errors.ts` — типизированные коды ошибок `AUTH_*`).
- **Точки входа:** `authResolver.resolve({ credentialRef, requiredScopes })` — вызывается из `services.ts` каждого доменного модуля.
- **Зависимости:** `src/lib/db.ts` (чтение/обновление токенов), `src/lib/auth.ts` (OAuth2-клиент).
- **Read/Write:** может обновлять (refresh) и персистить токены; не пишет в YouTube.
- **Важные ограничения безопасности:** несоответствие требуемых скоупов → `AUTH_SCOPE_INSUFFICIENT`; истёкший токен без refresh token → `AUTH_REFRESH_TOKEN_MISSING`; отсутствие локального пользователя (CLI/MCP) → `AUTH_USER_NOT_FOUND`.

### 2.3 Channel identity / write-context guardrails — **IMPLEMENTED**

- **Ответственность:** единственная реализация проверки `expectedChannelId` — блокирует write-операции, если активный OAuth-канал не совпадает с ожидаемым (fail-closed).
- **Файлы:** `src/lib/write-context/contracts.ts`, `service.ts` (`assertWriteChannel`, `getWriteChannelContext`, `listKnownChannels`, `selectWriteChannel`), `adapters/youtube-api.ts`.
- **Точки входа:** `writeContext.assertWriteChannel({ credentialRef, credentials, expectedChannelId })` — вызывается из `video-metadata/services.ts` (`applyMetadata`) и `playlist-management/services.ts` (create/update/delete).
- **Зависимости:** `src/lib/db.ts` (`getSelectedChannelId`/`setSelectedChannelId` — персистентный выбор канала).
- **Read/Write:** сам guardrail не пишет в YouTube; используется исключительно перед write-вызовами.
- **Важные ограничения безопасности:** несовпадение → `WRITE_CHANNEL_MISMATCH`; невозможность определить активный канал → `WRITE_CHANNEL_UNRESOLVED`; отсутствие `expectedChannelId` → `WRITE_CHANNEL_REQUIRED`. **`channel-sync` (Phase 2) этот guardrail не использует — синхронизация read-only и не нуждается в проверке канала записи** (см. `docs/ARCHITECTURE.md` §4.3).

### 2.4 YouTube API client layer — **IMPLEMENTED**

- **Ответственность:** единственная низкоуровневая обёртка над `googleapis` (`youtube_v3`).
- **Файлы:** `src/lib/youtube.ts` — общие функции (`createYoutubeClient`, `getAuthenticatedYoutube`, `getMyChannelId`, `listVideosByChannel`, `getVideoById`, `getVideoMetadataContext`, `applyVideoMetadataUpdate`, плейлист-функции) **плюс новые для Phase 2**: `getChannelForSync`, `listUploadsPlaylistVideoIds`, `getVideosMetadataContextBatch` (батчинг по ≤50 id за вызов `videos.list`).
- **Точки входа:** используется через тонкие адаптеры каждого доменного модуля (`video-metadata/adapters/youtube-api.ts`, `playlist-management/adapters/youtube-api.ts`, `channel-sync/adapters/youtube-api.ts`, `write-context/adapters/youtube-api.ts`) — не вызывается напрямую из сервисов.
- **Зависимости:** `src/lib/auth.ts` (создание OAuth2-клиента).
- **Read/Write:** содержит и read-, и write-методы (`applyVideoMetadataUpdate`, playlist create/update/delete/insert/delete-item). Методы, используемые `channel-sync`, — только read (`channels.list`, `playlistItems.list`, `videos.list`).
- **Важные ограничения безопасности:** не должен дублироваться — новый код обязан расширять этот файл, а не создавать параллельный клиент (`docs/PROJECT_SPEC.md` §3).

### 2.5 Persistence / database — **IMPLEMENTED**

- **Ответственность:** локальное хранилище на SQLite (libSQL), файл `data/playlist-manager.db`.
- **Файлы:** `src/lib/db.ts` — вся схема (`users`, `rules`, `channels`, `videos`) и CRUD-функции.
- **Точки входа:** прямой импорт функций из `db.ts` внутри адаптеров каждого модуля (`channel-sync/adapters/store.ts`, `write-context`'s `channelSelectionStore` и т.д.).
- **Зависимости:** нет (нижний уровень).
- **Read/Write:** и то, и другое (это и есть хранилище).
- **Важные ограничения безопасности:** OAuth-токены хранятся в открытом виде — приемлемо только для локального однопользовательского инструмента (см. `docs/UPSTREAM_ANALYSIS.md` §9, риск №1). Схема создаётся идемпотентно при старте (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` в try/catch) — **это осознанное решение, не миграционный инструмент**; решение и условие его пересмотра задокументированы в `docs/ARCHITECTURE.md` §6.2.

### 2.6 Channel synchronization (Phase 2) — **IMPLEMENTED**

- **Ответственность:** получение и локальное сохранение сведений о канале (`title`, `thumbnailUrl`, `uploadsPlaylistId`) при синхронизации.
- **Файлы:** `src/lib/channel-sync/{contracts,schemas,services,index}.ts`, `adapters/{youtube-api,store,logger}.ts`.
- **Точки входа:** `core.syncChannel({ credentialRef, channelId? })`, `core.listChannels(...)` — через `createChannelSyncCore()`.
- **Зависимости:** credential resolution (`resolveGoogleCredentials`), YouTube API layer (`getChannelForSync`), persistence (`upsertChannel`, `markChannelSynced`, `listStoredChannels`, `getStoredChannel`).
- **Read/Write:** **только чтение** YouTube (`channels.list`); запись — только в локальную БД.
- **Важные ограничения безопасности:** read-only scope (`YOUTUBE_READ_SCOPE`); guardrail write-context не применяется (не нужен для read-операции).

### 2.7 Video synchronization (Phase 2) — **IMPLEMENTED**

- **Ответственность:** перечисление всех видео канала через uploads playlist и батч-получение полных метаданных (`title`, `description`, `publishedAt`, `privacyStatus`, `defaultLanguage`, `defaultAudioLanguage`, `thumbnails`, `existingLocalizations`, `etag`) без one-request-per-video.
- **Файлы:** та же директория `src/lib/channel-sync/` (единый модуль с channel sync); низкоуровневая логика — `src/lib/youtube.ts` (`listUploadsPlaylistVideoIds`, `getVideosMetadataContextBatch`).
- **Точки входа:** `core.syncChannel(...)` (та же функция, что и для канала — один вызов синхронизирует и канал, и все его видео), `core.listSyncedVideos({ credentialRef, channelId })`.
- **Зависимости:** channel synchronization (нужен `uploadsPlaylistId`), YouTube API layer, persistence (`upsertVideos`, `listStoredVideosByChannel`).
- **Read/Write:** только чтение YouTube; upsert в таблицу `videos`.
- **Важные ограничения безопасности:** батчинг ≤50 id за вызов `videos.list` — обязательное требование (проверено тестами на реальной форме клиента `googleapis`, не только на моках уровня сервиса).

### 2.8 Localization-related read model (Phase 3) — **IMPLEMENTED**

- **Статус: реализовано как отдельный read-only доменный модуль `src/lib/localization/`.** Никаких новых таблиц БД и никаких новых вызовов YouTube API — это чистый read-model поверх того, что уже синхронизировал `channel-sync` (таблица `videos`).
- **Ответственность:** сводная таблица локализаций по каналу (какие языки есть/отсутствуют у каждого видео), детальный просмотр одного видео (оригинал + все существующие remote-локали), экспорт в XLSX (две вкладки: Videos, Localizations).
- **Файлы:** `src/lib/localization/{contracts,schemas,services,index,languages}.ts`, `adapters/{store,xlsx}.ts` (использует `exceljs`); UI — `src/components/localization-manager.tsx`.
- **Точки входа:** `core.getLocalizationOverview({credentialRef, channelId})`, `core.getVideoLocalizationDetail({credentialRef, channelId, videoId})`, `core.exportLocalizations({credentialRef, channelId, videoIds?})` — через `createLocalizationCore()`.
- **Зависимости:** persistence (`getStoredChannel`, `listStoredVideosByChannel` из `src/lib/db.ts` — те же функции, что использует `channel-sync`); `exceljs` для генерации файла.
- **Read/Write:** **только чтение** (ни одного вызова YouTube API вообще — нет даже `authResolver`, только проверка сессии на уровне API route); экспорт — генерация локального файла, не запись куда-либо.
- **Важные ограничения безопасности:** язык — производится как объединение (union) всех `existingLocalizations` по каналу, никогда не хардкодится (`docs/PROJECT_SPEC.md` §13); `video_id` — единственный canonical идентификатор в экспорте, никогда title.
- **Чего нет (после Phase 3):** draft/remote-состояний, change set, diff/approval UI, XLSX **import**, записи локализаций, конфигурации целевых языков канала. **Реализовано в Phase 4** — см. 2.9 ниже. По-прежнему нет: записи локализаций в YouTube (это Phase 5) — см. раздел 4.

### 2.9 Change sets / XLSX import / diff & approval (Phase 4) — **IMPLEMENTED** (local-only; real YouTube write remains **PLANNED**, Phase 5)

- **Статус: реализовано как отдельный доменный модуль `src/lib/changesets/`.** Новые таблицы БД (`change_sets`, `changes`), новый парсер XLSX-импорта, чистый (без React/DB) diff-движок, доменные сервисы, API-роуты, UI. **Ни одного вызова `videos.update` или любого другого write-метода YouTube API нигде в модуле** — approve/reject это только запись в локальную SQLite.
- **Ответственность:** парсинг и валидация загруженного XLSX (совместим с форматом экспорта Phase 3 — `remote_title`/`remote_description` уже были в экспорте с самого начала Phase 3 и служат baseline для conflict detection; Phase 4 лишь добавил необязательный лист `Meta` со `schema_version`/`exported_at`/`channel_id`), сопоставление `video_id`+`language` с синхронизированными данными канала, построение персистентного Change Set из валидных/невалидных строк (unchanged-и-валидные строки не сохраняются, только учитываются в сводке), field-level diff (ADD/MODIFY/UNCHANGED + conflictStatus), детерминированный жизненный цикл Change Set (`in_review`/`approved`/`partially_approved`/`rejected`, вычисляется чистой функцией `computeChangeSetStatus`), локальные approve/reject (одиночные и массовые), ревалидация конфликтов и инвалидация устаревшего approval при каждом чтении/действии.
- **Файлы:** `src/lib/changesets/{contracts,schemas,diff,import,services,index}.ts`, `adapters/store.ts`; UI — `src/components/change-set-review.tsx` + новый блок импорта в `src/components/localization-manager.tsx`.
- **Точки входа:** `core.previewImport(...)`, `core.createChangeSetFromImport(...)`, `core.listChangeSets(...)`, `core.getChangeSet(...)`, `core.approveChange(...)`, `core.rejectChange(...)`, `core.approveAllValid(...)`, `core.rejectAllPending(...)` — через `createChangeSetCore()`.
- **Зависимости:** persistence (`getStoredChannel`, `listStoredVideosByChannel` — те же функции, что использует `channel-sync`/`localization`, для получения *текущего* синхронизированного remote-значения), новые CRUD-функции в `src/lib/db.ts` для `change_sets`/`changes`, `exceljs` для парсинга (без вычисления формул — только `cell.result`/текст, импортируемый контент никогда не исполняется).
- **Read/Write:** **ноль вызовов YouTube API** (ни read, ни write) — весь модуль работает поверх уже синхронизированных локальных данных; запись — только в локальные таблицы `change_sets`/`changes`.
- **Важные ограничения безопасности:** blank-ячейка = нет изменения (`docs/PROJECT_SPEC.md` §8); `video_id` — единственный canonical идентификатор, строка с несуществующим/чужим `video_id` отклоняется как невалидная, а лист `Meta.channel_id`, не совпадающий с целевым каналом, блокирует **весь** импорт целиком (защита от импорта книги, экспортированной для другого канала); conflict detection сравнивает baseline экспорта с *последним синхронизированным* remote-значением — **не свежий вызов YouTube API** (задокументированное ограничение, см. `docs/ARCHITECTURE.md` §6.6); approve возможен только для `validationStatus: valid` + `conflictStatus: none`, а ранее выданный approval автоматически инвалидируется, если после ре-синхронизации remote-значение разошлось с baseline (`docs/ARCHITECTURE.md` §6.7).
- **Чего нет:** реальной записи локализаций в YouTube, immutable backup/audit log для write-операций, batch executor, CLI/MCP-инструментов для change sets, конфигурации deletion-предложений. Per-item execution ledger частично появился в Phase 5 Slice 1 — см. 2.9a.

### 2.9a Batch execution ledger + safety preparation + recovery/audit (Phase 5, Slices 1-3) — **PARTIALLY IMPLEMENTED**

- **Slice 3 (RECOVERY AND AUDIT), добавлено 2026-09-17.** Явная модель состояний ledger дополнена статусом `AWAITING_EXECUTION` (подготовлено, live-запись ещё не начата — заменяет прежнее использование `APPLYING` как «заглушки», раскритикованное владельцем проекта: `APPLYING` теперь означает исключительно «attempt реально выполняется»). Новый модуль `src/lib/audit/` — durable append-only audit trail (`PREPARATION`/`ATTEMPT`/`RESULT`/`CONFLICT`/`VERIFICATION`/`DRY_RUN`/`RECONCILIATION`), таблица `audit_events` (упорядочена по rowid). Реализован §0.F reconciliation (два bounded-чтения, никогда не авторизует retry сам по себе), §0.E bounded retry (4 попытки, classification transient/permanent от исполнителя), обязательная post-write verification перед любым `SUCCESS` (`AC-VERIFY-01/02`, `AC-CONFLICT-02`), причинно-осознанный audit (`AC-AUDIT-05`: `ownResponseObserved` отличает подтверждённый собственным ответом `SUCCESS` от подтверждённого через reconciliation). `executeBatch`/`executeWithRetry` — новая оркестрация, гоняющая `AWAITING_EXECUTION`-строки через обязательную повторную safety-проверку непосредственно перед отправкой (переиспользует ту же `runSafetyPipeline`, что и Slice 2, — общий guardrail, не дублирование). Item-level isolation + systemic abort (включая quota) + downloadable error report (`getBatchErrorReport`). Crash recovery — `recoverBatch`/`recoverLedgerRow`, идемпотентны при повторных перезапусках, никогда не освобождают лок только по таймауту, никогда не изобретают неподтверждённый API-вызов.
- **Найденные и исправленные в ходе Slice 3 баги Foundation-слоя:** несколько функций в `src/lib/db.ts` (`transitionLedgerRowStatus`, `markBatchTerminal`, `listStoredLedgerRowsByBatch`, `listStoredAttemptsByBatch`) никогда не принимали параметр `database` и продолжали писать/читать singleton вместо переданной изолированной БД — баг не проявлялся в тестах на fake-store (Slice 1/2) и обнаружился только при добавлении реального SQLite-теста восстановления после сбоя. Также обнаружено расхождение: `src/lib/db.ts` держит собственную копию типа `LedgerStatus`, не синхронизированную с `src/lib/batches/contracts.ts` (не содержала `DRY_RUN_COMPLETE`/`AWAITING_EXECUTION`) — исправлено вручную, отмечено как известный source-of-truth риск (см. `docs/TECHNICAL_DEBT.md`).

- **Статус: Slices 1-2 из утверждённого пятислойного implementation plan Phase 5** (`docs/acceptance/PHASE_5_ACCEPTANCE.md`, статус APPROVED). Slice 1: сущность `Batch` с неизменяемым составом (`AC-BATCH-01/02`), per-video execution ledger (`AC-LEDGER-01`), durable двухфазная (`INTENDED` → результат) запись attempt-намерения (`AC-ATTEMPT-02/03`), явная модель состояний и atomic-локи (`AC-CONCURRENCY-01/02/03`) — включая исправление от 2026-09-17 по итогам Foundation safety verification: слот `active_attempt_id` на ledger row (не только UNIQUE-констрейнт) гарантирует не более одного активного attempt на строку под реальной конкурентностью.
- **Slice 2 (SAFETY PREPARATION), добавлено 2026-09-17:** переиспользование `write-context.assertWriteChannel` перед любой работой batch (`AC-GUARD-01`); re-check approval/validation/conflict каждого `Change` как при создании batch, так и непосредственно перед подготовкой записи, одной и той же функцией (`AC-MERGE-04`, `AC-BATCH-03`); `src/lib/batches/merge.ts` — чистая логика defaultLanguage-проверки (`AC-DEFAULTLANG-01/02`), pre-write conflict detection против **свежего** fetch (`AC-CONFLICT-01`/`AC-LEDGER-04`, закрывает `RISK-03` для пайплайна подготовки), safe merge с сохранением нетронутых locale/snippet-полей (`AC-MERGE-01..03`, `AC-MULTI-01`); новый модуль `src/lib/backup/` — immutable backup с разделением item-level/infrastructure-wide отказа, никогда не перезаписывается (`AC-BACKUP-01..04`); dry-run проходит весь pipeline (identity → fetch → merge → backup) и не делает ни одного write-вызова, ledger row переходит в отдельный терминальный статус `DRY_RUN_COMPLETE`, никогда не `SUCCESS` (`AC-DRYRUN-01/02/03`). Явно разделены batched preliminary fetch (`fetchPreliminaryBatchContext`) и обязательный fresh single-video fetch (`fetchFreshVideoContext`) — merge/conflict/backup всегда используют только второй.
- **Файлы:** `src/lib/batches/{contracts,schemas,services,merge,index}.ts`, `adapters/{store.ts,write-executor.fake.ts,youtube-api.ts}`; `src/lib/backup/{contracts,services,index}.ts`, `adapters/filesystem-store.ts`; новые таблицы в `src/lib/db.ts` (`batches`, `batch_ledger_rows` — с `active_attempt_id`, `batch_attempts`, `video_execution_locks`), схема инициализации остаётся аддитивной (`docs/decisions/0001-additive-idempotent-schema-strategy.md`).
- **Чего явно нет после Slice 3** (см. отчёт о реализации, не путать с «готово»): реальный YouTube-адаптер за портом `WriteExecutor` (единственное, что остаётся для Slice 4). **Ни один код-путь в репозитории не может достичь реального вызова `videos.update`** — `executeBatch`/`executeWithRetry`/`recoverBatch` принимают/используют абстрактный `WriteExecutor`, но нигде в production-коде (`index.ts`) он не конструируется и не передаётся; единственная реализация — тестовый fake (`adapters/write-executor.fake.ts`) и тестовые скрипты, вызываемые исключительно из тестов. API-роутов, CLI-команд и MCP-инструментов для этого модуля пока не существует.

### 2.10 Web UI — **IMPLEMENTED**

- **Ответственность:** дашборд оператора (`/dashboard`) с вкладками Manual / Rules / Sync / Localizations.
- **Файлы:** `src/app/page.tsx` (страница входа), `src/app/dashboard/page.tsx`, `src/components/{manual-mode,rule-form,rule-list,run-button,session-provider,channel-sync,localization-manager,change-set-review}.tsx`.
- **Точки входа:** браузер → `http://localhost:3000` → NextAuth Google sign-in → `/dashboard`.
- **Зависимости:** API routes (`src/app/api/**`), сессия NextAuth.
- **Read/Write:** вкладки **Sync** и **Localizations** — читают YouTube только через уже синхронизированные данные (Localizations вообще не вызывает YouTube API); XLSX-импорт и approve/reject в Localizations (Phase 4) — только локальная запись в БД, тоже без вызовов YouTube API; вкладка **Manual** — может писать в YouTube (add/remove из плейлиста, создание плейлиста).
- **Важные ограничения безопасности:** каждый API route, к которому обращается UI, сам проверяет сессию (`getServerSession`) и (для write) guardrail канала — UI не является границей безопасности.

### 2.11 API routes — **IMPLEMENTED**

- **Ответственность:** HTTP-граница между Web UI (и потенциально внешними интеграциями) и доменными сервисами.
- **Файлы:**
  - Существующие: `src/app/api/video-metadata/{apply,preview,transcript}/route.ts`, `src/app/api/youtube/{videos,playlists,create-playlist,add-to-playlist,remove-from-playlist,channel-info}/route.ts`, `src/app/api/rules/route.ts`, `src/app/api/run/route.ts`, `src/app/api/auth/[...nextauth]/route.ts`.
  - **Новые (Phase 2):** `GET /api/channels` (`route.ts`), `POST /api/channels/sync` (`sync/route.ts`), `GET /api/channels/[channelId]/videos` (`[channelId]/videos/route.ts`).
  - **Новые (Phase 3):** `GET /api/channels/[channelId]/localizations` (обзорная таблица), `GET /api/channels/[channelId]/localizations/[videoId]` (детали видео), `GET /api/channels/[channelId]/localizations/export` (XLSX-файл, `?videoIds=a,b,c` опционально).
  - **Новые (Phase 4):** `POST /api/channels/[channelId]/localizations/import/preview` (multipart, без персистентности), `POST /api/channels/[channelId]/localizations/import` (multipart, создаёт Change Set), `GET /api/channels/[channelId]/change-sets` (список), `GET /api/channels/[channelId]/change-sets/[changeSetId]` (детали + ревалидация конфликтов, фильтры/пагинация), `POST .../change-sets/[changeSetId]/changes/[changeId]/approve`, `POST .../changes/[changeId]/reject`, `POST .../change-sets/[changeSetId]/approve-all`, `POST .../change-sets/[changeSetId]/reject-all`.
- **Точки входа:** HTTP-запросы, каждый начинается с `getServerSession(authOptions)`.
- **Зависимости:** соответствующий доменный core (`createVideoMetadataCore()`, `createPlaylistManagementCore()`, `createChannelSyncCore()`, `createLocalizationCore()`, `createChangeSetCore()`), общие `error-status.ts`/`parse-json-body.ts` из `video-metadata` (переиспользуются, не дублируются).
- **Read/Write:** зависит от роута; все новые роуты Phase 2–4 не пишут в YouTube (export/import/approve — либо чтение, либо только локальная запись в БД).
- **Важные ограничения безопасности:** без валидной сессии — `401` до вызова доменной логики; каждый change-set роут проверяет, что `changeSetId` принадлежит указанному `channelId` (`not_found` иначе), чтобы нельзя было прочитать/изменить change set через чужой канал.

### 2.12 CLI — **IMPLEMENTED** (metadata/auth/playlist); sync/localization/changesets commands are **PLANNED** (see `docs/TECHNICAL_DEBT.md` RISK-04)

- **Ответственность:** локальный терминальный интерфейс для metadata/auth/playlist операций.
- **Файлы:** `src/cli/video-metadata.ts` (namespaces: `metadata`, `auth`, `playlist`).
- **Точки входа:** `npm run cli:video-metadata -- <namespace> <command>`.
- **Зависимости:** `createVideoMetadataCore()`, `createPlaylistManagementCore()`, `createCliAuthService()`.
- **Read/Write:** оба (например, `apply`, `playlist create/update/delete`).
- **Важные ограничения безопасности:** JSON-конверты на stdout (`{ ok: true|false, ... }`), ненулевой exit code при ошибке.
- **Ограничение (Phase 2–4): команд синхронизации каналов/видео, локализаций и change sets в CLI нет.**

### 2.13 MCP — **IMPLEMENTED** (metadata/auth/playlist tools); sync/localization/changesets tools are **PLANNED** (see `docs/TECHNICAL_DEBT.md` RISK-04)

- **Ответственность:** stdio MCP-сервер для AI-агентов.
- **Файлы:** `src/mcp/server.ts` (`createMcpServer`, `createMcpToolHandlers`).
- **Точки входа:** `npm run mcp:video-metadata`; инструменты: `write_context`, `write_channel_list`, `write_channel_select`, `whoami`, `auth_user_select`, `list`, `transcript`, `preview`, `apply`, `playlist_list`, `playlist_create`, `playlist_update`, `playlist_delete`, `playlist_add_videos`, `playlist_remove_videos`.
- **Зависимости:** те же core-фабрики, что и CLI; `resolveEffectiveCredentialRef` из `cli-auth`.
- **Read/Write:** оба (`apply`, `playlist_*` — write, с `dryRun`-поддержкой для `apply`).
- **Важные ограничения безопасности:** все входы — строгие Zod-схемы; все ошибки — структурированный JSON, никогда голый текст.
- **Ограничение (Phase 2–4): MCP-инструментов синхронизации каналов/видео, локализаций и change sets нет.**

### 2.14 Tests — **IMPLEMENTED**

- **Ответственность:** unit/integration-тесты на моках (без реальных сетевых вызовов к YouTube).
- **Файлы:** `*.test.ts` рядом с тестируемым модулем; раннер — `node --import tsx --test "src/**/*.test.ts"` (встроенный `node:test`, без Jest/Vitest).
- **Новые файлы Phase 2:** `src/lib/youtube.test.ts` (батчинг/пагинация против моков реальной формы `googleapis`-клиента), `src/lib/channel-sync/services.test.ts` (sync/list на фейковом store).
- **Новые файлы Phase 3:** `src/lib/localization/services.test.ts` (overview/detail/export на фейковом store), `src/lib/localization/adapters/xlsx.test.ts` (реальная сборка workbook через `exceljs` + чтение обратно, без моков библиотеки).
- **Новые файлы Phase 4:** `src/lib/changesets/diff.test.ts` (чистая классификация/статусы/инвалидация approval), `src/lib/changesets/import.test.ts` (парсинг/валидация реальных XLSX-книг через `exceljs`: blank=no-change, дубликаты, невалидный язык, конфликт, channel mismatch, лимиты размера), `src/lib/changesets/services.test.ts` (сквозные сценарии: создание change set, approve/reject, ре-синхронизация инвалидирует approval, bulk approve не трогает невалидные/конфликтующие строки, изоляция между каналами).
- **Текущее состояние:** 226 тестов, все проходят (`npm test`).
- **Важное ограничение:** ни один тест не пишет в реальный YouTube-канал (`docs/PROJECT_SPEC.md` §42); Phase 4 тесты дополнительно доказывают, что import/approve не может вызвать ни одного YouTube write-метода (нет такого метода в зависимостях сервисов вообще).

### 2.15 Configuration / local state — **IMPLEMENTED**

- **Ответственность:** переменные окружения и локальные файлы состояния.
- **Файлы:** `.env.local` (не в репозитории; обязательные `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`; опциональные `CLI_OAUTH_CALLBACK_PORT`, `YOUTUBE_TRANSCRIPT_PROVIDER`, `METADATA_GENERATOR_MODE`, `METADATA_GENERATOR_RAW_OUTPUT`), `data/playlist-manager.db` (SQLite), `data/auth-context.json` (активный локальный пользователь CLI/MCP).
- **Важные ограничения безопасности:** `data/*.db`, `data/auth-context.json`, `data/oauth/`, `data/tokens/`, `credentials/`, `.env*` — всё в `.gitignore`; секреты никогда не попадают в логи или к AI-провайдеру.

---

## 3. Где вносить изменения

| Задача | Где |
|---|---|
| Добавить новую read-операцию YouTube | Низкоуровневая функция в `src/lib/youtube.ts`, затем обёртка в `adapters/youtube-api.ts` нужного доменного модуля |
| Добавить новый доменный модуль | Новая директория `src/lib/<module>/` с `contracts.ts` / `schemas.ts` / `services.ts` / `adapters/` / `index.ts` — по образцу `channel-sync/` или `playlist-management/` |
| Добавить новый API route | `src/app/api/<path>/route.ts`, переиспользуя `getVideoMetadataErrorStatus` и `parseVideoMetadataJsonBody` из `src/app/api/video-metadata/` |
| Добавить новую CLI-команду | Новый namespace/command в `src/cli/video-metadata.ts`, по образцу существующих `metadata`/`auth`/`playlist` |
| Добавить новый MCP-инструмент | `server.registerTool(...)` в `src/mcp/server.ts` + обработчик в `createMcpToolHandlers` |
| Добавить новую персистентную сущность | Новая `sqliteTable` + `CREATE TABLE IF NOT EXISTS` в `initializeDatabase()` внутри `src/lib/db.ts` (пока схема аддитивна — см. `docs/ARCHITECTURE.md` §6.2 про решение по миграциям) |
| Добавить новый safe write workflow | Переиспользовать `write-context.assertWriteChannel` (не копировать проверку); придерживаться модели identity check → validation → backup → diff → approval → dry-run → audit → verification из `docs/PROJECT_SPEC.md` |

---

## 4. Статус компонентов

### 4.0 Ключевые ограничения (не путать с «не реализовано» — это активные инварианты, которые должен знать любой агент, прежде чем предлагать write-функциональность)

- **Approval ≠ применено к YouTube.** `Change.approvalStatus === "approved"` — это только локальная запись в SQLite (`docs/ARCHITECTURE.md` §6.9). Ни один код-путь в `src/lib/changesets/` не вызывает `googleapis`.
- **Conflict detection в Phase 4 сверяется с последним синхронизированным SQLite-снимком, а не с живым состоянием YouTube.** Свежая проверка remote-состояния непосредственно перед записью обязательна для Phase 5 (`docs/TECHNICAL_DEBT.md` RISK-03).
- **Приложение работает по модели single-operator.** Нет per-user ownership-границы по каналам (`docs/TECHNICAL_DEBT.md` RISK-02) — это осознанное допущение для локального инструмента, а не завершённая multi-tenant модель.
- **Change Set CLI/MCP-интерфейсов не существует** (`docs/TECHNICAL_DEBT.md` RISK-04) — вся Phase 4 функциональность доступна только через Web UI/API.
- **Живая browser/OAuth-проверка не выполнена независимо** (`docs/TECHNICAL_DEBT.md` RISK-05) — автоматические тесты и один сквозной прогон на реальной БД/реальном экспорте существуют, но реального клика в браузере с настоящей Google-сессией не было.

**Реализовано и работает (проверено тестами):**
Auth (Web + CLI PKCE/device flow), credential resolution, write-context guardrail, YouTube client layer (read + write методы для metadata/playlist), persistence (`users`, `rules`, `channels`, `videos`, `change_sets`, `changes`, `batches`, `batch_ledger_rows`, `batch_attempts`, `video_execution_locks`, `audit_events`), channel-sync (канал + видео, батчинг), localization read model + XLSX export (Phase 3), **XLSX import + draft state + change sets + field-level diff + local approve/reject + conflict detection (Phase 4)**, **Batch/ledger/attempt data model, concurrency locks, safety preparation (identity/approval/fresh-fetch/conflict/backup/merge/dry-run), retry+reconciliation+verification, durable audit, crash recovery, item-level/systemic isolation (Phase 5, Slices 1-3 — см. 2.9a; реального `videos.update` по-прежнему нигде нет)**, Web UI (Manual/Rules/Sync/Localizations, включая Import и Change Set Review), API routes (metadata/playlist/youtube/rules/run/channels/localizations/change-sets), CLI (metadata/auth/playlist), MCP (metadata/playlist tools), 288 тестов.

**Запланировано, но не реализовано (Phase 5, Slice 4 — единственное оставшееся):**
- Реальный YouTube-адаптер за портом `WriteExecutor` — Slices 1-3 построили весь pipeline (ledger/attempt/retry/reconciliation/verification/audit/recovery/isolation) поверх абстрактного порта; ни один approved change по-прежнему не отправляется в YouTube ни при каких обстоятельствах.
- CLI-команды и MCP-инструменты для синхронизации каналов/видео, localization и change sets (`channel_sync`, `channel_list`, `video_list`, `localization_list`, `localization_export`, `changeset_list`, `changeset_approve` и т.п.).
- Конфигурация целевых языков канала (сейчас язык — это только то, что уже есть в существующих локализациях; см. `docs/ARCHITECTURE.md` §5.4).
- Явная модель deletion-предложений (осознанно отложена в Phase 4, см. `docs/ARCHITECTURE.md` §6.14).
- AI-генерация локализаций (провайдер-агностичный интерфейс, драфты через тот же approval pipeline).

**Осознанно отложено (не входит в текущий MVP, см. `docs/PROJECT_SPEC.md` §58):**
YouTube Analytics, AI-генерация метаданных, publishing/upload видео, thumbnail-модуль, multi-user SaaS/RBAC, миграция БД-инструментария (Drizzle Kit) — до первого неаддитивного изменения схемы.

---

## 5. Замечание про безопасность записи (сквозной инвариант)

Единственный существующий write-путь для метаданных — `video-metadata/services.ts` → `applyMetadata` (identity check + guardrail + diff + опциональный dry-run, без backup/audit/verification — это уже задокументированный пробел в `docs/UPSTREAM_ANALYSIS.md` §7). Любой новый write-путь **обязан** проходить через `write-context.assertWriteChannel`, а не через собственную проверку канала.
