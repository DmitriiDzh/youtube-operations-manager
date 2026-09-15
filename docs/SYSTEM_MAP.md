# SYSTEM_MAP.md

Быстрая карта репозитория для агентов-кодеров (Claude/Codex), заходящих в проект впервые. Описывает систему **как она есть** после завершения Phase 3 (read-only синхронизация каналов/видео + Localization Manager read-only UI/XLSX export). Не описывает нереализованные фичи как существующие — см. раздел 4 про статус компонентов.

Смежные документы:

- `docs/PROJECT_SPEC.md` — продуктовый roadmap, модель безопасности записи, фазы.
- `docs/ARCHITECTURE.md` — подробное описание архитектуры Phase 2 (channel-sync) и Phase 3 (localization + XLSX export), решение по стратегии миграций БД.
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

### 2.1 Authentication / OAuth

- **Ответственность:** Google OAuth (веб-сессия через NextAuth + CLI/MCP через PKCE-loopback или device flow).
- **Файлы:** `src/lib/auth.ts` (`authOptions`, `YOUTUBE_SCOPES`, `buildGoogleLoopbackAuthUrl`, `startGoogleDeviceAuthorization`, `pollGoogleDeviceAuthorizationToken`, `exchangeGoogleAuthCode`, `revokeGoogleToken`), `src/app/api/auth/[...nextauth]/route.ts`.
- **Точки входа:** веб — `getServerSession(authOptions)` в каждом API route handler; CLI — `npm run cli:video-metadata -- auth login [--device]`.
- **Зависимости:** `src/lib/db.ts` (сохранение токенов в `users`).
- **Read/Write:** сама по себе не пишет в YouTube; получает/обновляет OAuth-токены.
- **Важные ограничения безопасности:** access/refresh токены никогда не логируются и не уходят в браузерный JS; хранение — только на сервере/локально.

### 2.2 Credential resolution

- **Ответственность:** превращение `CredentialRef` (`{ userId }` или явные токены) в `ResolvedCredentials` с проверкой достаточности OAuth-скоупов и автообновлением истёкшего access token.
- **Файлы:** `src/lib/video-metadata/adapters/google-auth.ts` (`resolveGoogleCredentials`, используется всеми доменными модулями, включая `channel-sync`), `src/lib/cli-auth/*` (для CLI/MCP: `service.ts`, `storage.ts` — файл `data/auth-context.json` с активным локальным пользователем, `errors.ts` — типизированные коды ошибок `AUTH_*`).
- **Точки входа:** `authResolver.resolve({ credentialRef, requiredScopes })` — вызывается из `services.ts` каждого доменного модуля.
- **Зависимости:** `src/lib/db.ts` (чтение/обновление токенов), `src/lib/auth.ts` (OAuth2-клиент).
- **Read/Write:** может обновлять (refresh) и персистить токены; не пишет в YouTube.
- **Важные ограничения безопасности:** несоответствие требуемых скоупов → `AUTH_SCOPE_INSUFFICIENT`; истёкший токен без refresh token → `AUTH_REFRESH_TOKEN_MISSING`; отсутствие локального пользователя (CLI/MCP) → `AUTH_USER_NOT_FOUND`.

### 2.3 Channel identity / write-context guardrails

- **Ответственность:** единственная реализация проверки `expectedChannelId` — блокирует write-операции, если активный OAuth-канал не совпадает с ожидаемым (fail-closed).
- **Файлы:** `src/lib/write-context/contracts.ts`, `service.ts` (`assertWriteChannel`, `getWriteChannelContext`, `listKnownChannels`, `selectWriteChannel`), `adapters/youtube-api.ts`.
- **Точки входа:** `writeContext.assertWriteChannel({ credentialRef, credentials, expectedChannelId })` — вызывается из `video-metadata/services.ts` (`applyMetadata`) и `playlist-management/services.ts` (create/update/delete).
- **Зависимости:** `src/lib/db.ts` (`getSelectedChannelId`/`setSelectedChannelId` — персистентный выбор канала).
- **Read/Write:** сам guardrail не пишет в YouTube; используется исключительно перед write-вызовами.
- **Важные ограничения безопасности:** несовпадение → `WRITE_CHANNEL_MISMATCH`; невозможность определить активный канал → `WRITE_CHANNEL_UNRESOLVED`; отсутствие `expectedChannelId` → `WRITE_CHANNEL_REQUIRED`. **`channel-sync` (Phase 2) этот guardrail не использует — синхронизация read-only и не нуждается в проверке канала записи** (см. `docs/ARCHITECTURE.md` §4.3).

### 2.4 YouTube API client layer

- **Ответственность:** единственная низкоуровневая обёртка над `googleapis` (`youtube_v3`).
- **Файлы:** `src/lib/youtube.ts` — общие функции (`createYoutubeClient`, `getAuthenticatedYoutube`, `getMyChannelId`, `listVideosByChannel`, `getVideoById`, `getVideoMetadataContext`, `applyVideoMetadataUpdate`, плейлист-функции) **плюс новые для Phase 2**: `getChannelForSync`, `listUploadsPlaylistVideoIds`, `getVideosMetadataContextBatch` (батчинг по ≤50 id за вызов `videos.list`).
- **Точки входа:** используется через тонкие адаптеры каждого доменного модуля (`video-metadata/adapters/youtube-api.ts`, `playlist-management/adapters/youtube-api.ts`, `channel-sync/adapters/youtube-api.ts`, `write-context/adapters/youtube-api.ts`) — не вызывается напрямую из сервисов.
- **Зависимости:** `src/lib/auth.ts` (создание OAuth2-клиента).
- **Read/Write:** содержит и read-, и write-методы (`applyVideoMetadataUpdate`, playlist create/update/delete/insert/delete-item). Методы, используемые `channel-sync`, — только read (`channels.list`, `playlistItems.list`, `videos.list`).
- **Важные ограничения безопасности:** не должен дублироваться — новый код обязан расширять этот файл, а не создавать параллельный клиент (`docs/PROJECT_SPEC.md` §3).

### 2.5 Persistence / database

- **Ответственность:** локальное хранилище на SQLite (libSQL), файл `data/playlist-manager.db`.
- **Файлы:** `src/lib/db.ts` — вся схема (`users`, `rules`, `channels`, `videos`) и CRUD-функции.
- **Точки входа:** прямой импорт функций из `db.ts` внутри адаптеров каждого модуля (`channel-sync/adapters/store.ts`, `write-context`'s `channelSelectionStore` и т.д.).
- **Зависимости:** нет (нижний уровень).
- **Read/Write:** и то, и другое (это и есть хранилище).
- **Важные ограничения безопасности:** OAuth-токены хранятся в открытом виде — приемлемо только для локального однопользовательского инструмента (см. `docs/UPSTREAM_ANALYSIS.md` §9, риск №1). Схема создаётся идемпотентно при старте (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` в try/catch) — **это осознанное решение, не миграционный инструмент**; решение и условие его пересмотра задокументированы в `docs/ARCHITECTURE.md` §6.2.

### 2.6 Channel synchronization (Phase 2, новое)

- **Ответственность:** получение и локальное сохранение сведений о канале (`title`, `thumbnailUrl`, `uploadsPlaylistId`) при синхронизации.
- **Файлы:** `src/lib/channel-sync/{contracts,schemas,services,index}.ts`, `adapters/{youtube-api,store,logger}.ts`.
- **Точки входа:** `core.syncChannel({ credentialRef, channelId? })`, `core.listChannels(...)` — через `createChannelSyncCore()`.
- **Зависимости:** credential resolution (`resolveGoogleCredentials`), YouTube API layer (`getChannelForSync`), persistence (`upsertChannel`, `markChannelSynced`, `listStoredChannels`, `getStoredChannel`).
- **Read/Write:** **только чтение** YouTube (`channels.list`); запись — только в локальную БД.
- **Важные ограничения безопасности:** read-only scope (`YOUTUBE_READ_SCOPE`); guardrail write-context не применяется (не нужен для read-операции).

### 2.7 Video synchronization (Phase 2, новое)

- **Ответственность:** перечисление всех видео канала через uploads playlist и батч-получение полных метаданных (`title`, `description`, `publishedAt`, `privacyStatus`, `defaultLanguage`, `defaultAudioLanguage`, `thumbnails`, `existingLocalizations`, `etag`) без one-request-per-video.
- **Файлы:** та же директория `src/lib/channel-sync/` (единый модуль с channel sync); низкоуровневая логика — `src/lib/youtube.ts` (`listUploadsPlaylistVideoIds`, `getVideosMetadataContextBatch`).
- **Точки входа:** `core.syncChannel(...)` (та же функция, что и для канала — один вызов синхронизирует и канал, и все его видео), `core.listSyncedVideos({ credentialRef, channelId })`.
- **Зависимости:** channel synchronization (нужен `uploadsPlaylistId`), YouTube API layer, persistence (`upsertVideos`, `listStoredVideosByChannel`).
- **Read/Write:** только чтение YouTube; upsert в таблицу `videos`.
- **Важные ограничения безопасности:** батчинг ≤50 id за вызов `videos.list` — обязательное требование (проверено тестами на реальной форме клиента `googleapis`, не только на моках уровня сервиса).

### 2.8 Localization-related read model (Phase 3, новое)

- **Статус: реализовано как отдельный read-only доменный модуль `src/lib/localization/`.** Никаких новых таблиц БД и никаких новых вызовов YouTube API — это чистый read-model поверх того, что уже синхронизировал `channel-sync` (таблица `videos`).
- **Ответственность:** сводная таблица локализаций по каналу (какие языки есть/отсутствуют у каждого видео), детальный просмотр одного видео (оригинал + все существующие remote-локали), экспорт в XLSX (две вкладки: Videos, Localizations).
- **Файлы:** `src/lib/localization/{contracts,schemas,services,index,languages}.ts`, `adapters/{store,xlsx}.ts` (использует `exceljs`); UI — `src/components/localization-manager.tsx`.
- **Точки входа:** `core.getLocalizationOverview({credentialRef, channelId})`, `core.getVideoLocalizationDetail({credentialRef, channelId, videoId})`, `core.exportLocalizations({credentialRef, channelId, videoIds?})` — через `createLocalizationCore()`.
- **Зависимости:** persistence (`getStoredChannel`, `listStoredVideosByChannel` из `src/lib/db.ts` — те же функции, что использует `channel-sync`); `exceljs` для генерации файла.
- **Read/Write:** **только чтение** (ни одного вызова YouTube API вообще — нет даже `authResolver`, только проверка сессии на уровне API route); экспорт — генерация локального файла, не запись куда-либо.
- **Важные ограничения безопасности:** язык — производится как объединение (union) всех `existingLocalizations` по каналу, никогда не хардкодится (`docs/PROJECT_SPEC.md` §13); `video_id` — единственный canonical идентификатор в экспорте, никогда title.
- **Чего нет:** draft/remote-состояний, change set, diff/approval UI, XLSX **import**, записи локализаций, конфигурации целевых языков канала — см. раздел 4.

### 2.9 Web UI

- **Ответственность:** дашборд оператора (`/dashboard`) с вкладками Manual / Rules / Sync / Localizations.
- **Файлы:** `src/app/page.tsx` (страница входа), `src/app/dashboard/page.tsx`, `src/components/{manual-mode,rule-form,rule-list,run-button,session-provider,channel-sync,localization-manager}.tsx`.
- **Точки входа:** браузер → `http://localhost:3000` → NextAuth Google sign-in → `/dashboard`.
- **Зависимости:** API routes (`src/app/api/**`), сессия NextAuth.
- **Read/Write:** вкладки **Sync** и **Localizations** — только чтение YouTube (Localizations вообще не вызывает YouTube API, только локальный кэш + генерация XLSX); вкладка **Manual** — может писать (add/remove из плейлиста, создание плейлиста).
- **Важные ограничения безопасности:** каждый API route, к которому обращается UI, сам проверяет сессию (`getServerSession`) и (для write) guardrail канала — UI не является границей безопасности.

### 2.10 API routes

- **Ответственность:** HTTP-граница между Web UI (и потенциально внешними интеграциями) и доменными сервисами.
- **Файлы:**
  - Существующие: `src/app/api/video-metadata/{apply,preview,transcript}/route.ts`, `src/app/api/youtube/{videos,playlists,create-playlist,add-to-playlist,remove-from-playlist,channel-info}/route.ts`, `src/app/api/rules/route.ts`, `src/app/api/run/route.ts`, `src/app/api/auth/[...nextauth]/route.ts`.
  - **Новые (Phase 2):** `GET /api/channels` (`route.ts`), `POST /api/channels/sync` (`sync/route.ts`), `GET /api/channels/[channelId]/videos` (`[channelId]/videos/route.ts`).
  - **Новые (Phase 3):** `GET /api/channels/[channelId]/localizations` (обзорная таблица), `GET /api/channels/[channelId]/localizations/[videoId]` (детали видео), `GET /api/channels/[channelId]/localizations/export` (XLSX-файл, `?videoIds=a,b,c` опционально).
- **Точки входа:** HTTP-запросы, каждый начинается с `getServerSession(authOptions)`.
- **Зависимости:** соответствующий доменный core (`createVideoMetadataCore()`, `createPlaylistManagementCore()`, `createChannelSyncCore()`, `createLocalizationCore()`), общие `error-status.ts`/`parse-json-body.ts` из `video-metadata` (переиспользуются, не дублируются).
- **Read/Write:** зависит от роута; все новые роуты Phase 2 и Phase 3 — read-only (export XLSX генерирует файл, но не пишет ничего внешнего).
- **Важные ограничения безопасности:** без валидной сессии — `401` до вызова доменной логики.

### 2.11 CLI

- **Ответственность:** локальный терминальный интерфейс для metadata/auth/playlist операций.
- **Файлы:** `src/cli/video-metadata.ts` (namespaces: `metadata`, `auth`, `playlist`).
- **Точки входа:** `npm run cli:video-metadata -- <namespace> <command>`.
- **Зависимости:** `createVideoMetadataCore()`, `createPlaylistManagementCore()`, `createCliAuthService()`.
- **Read/Write:** оба (например, `apply`, `playlist create/update/delete`).
- **Важные ограничения безопасности:** JSON-конверты на stdout (`{ ok: true|false, ... }`), ненулевой exit code при ошибке.
- **Ограничение (Phase 2/3): команд синхронизации каналов/видео и локализаций в CLI нет.**

### 2.12 MCP

- **Ответственность:** stdio MCP-сервер для AI-агентов.
- **Файлы:** `src/mcp/server.ts` (`createMcpServer`, `createMcpToolHandlers`).
- **Точки входа:** `npm run mcp:video-metadata`; инструменты: `write_context`, `write_channel_list`, `write_channel_select`, `whoami`, `auth_user_select`, `list`, `transcript`, `preview`, `apply`, `playlist_list`, `playlist_create`, `playlist_update`, `playlist_delete`, `playlist_add_videos`, `playlist_remove_videos`.
- **Зависимости:** те же core-фабрики, что и CLI; `resolveEffectiveCredentialRef` из `cli-auth`.
- **Read/Write:** оба (`apply`, `playlist_*` — write, с `dryRun`-поддержкой для `apply`).
- **Важные ограничения безопасности:** все входы — строгие Zod-схемы; все ошибки — структурированный JSON, никогда голый текст.
- **Ограничение (Phase 2/3): MCP-инструментов синхронизации каналов/видео и локализаций нет.**

### 2.13 Tests

- **Ответственность:** unit/integration-тесты на моках (без реальных сетевых вызовов к YouTube).
- **Файлы:** `*.test.ts` рядом с тестируемым модулем; раннер — `node --import tsx --test "src/**/*.test.ts"` (встроенный `node:test`, без Jest/Vitest).
- **Новые файлы Phase 2:** `src/lib/youtube.test.ts` (батчинг/пагинация против моков реальной формы `googleapis`-клиента), `src/lib/channel-sync/services.test.ts` (sync/list на фейковом store).
- **Новые файлы Phase 3:** `src/lib/localization/services.test.ts` (overview/detail/export на фейковом store), `src/lib/localization/adapters/xlsx.test.ts` (реальная сборка workbook через `exceljs` + чтение обратно, без моков библиотеки).
- **Текущее состояние:** 188 тестов, все проходят (`npm test`).
- **Важное ограничение:** ни один тест не пишет в реальный YouTube-канал (`docs/PROJECT_SPEC.md` §42).

### 2.14 Configuration / local state

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

**Реализовано и работает (проверено тестами):**
Auth (Web + CLI PKCE/device flow), credential resolution, write-context guardrail, YouTube client layer (read + write методы для metadata/playlist), persistence (`users`, `rules`, `channels`, `videos`), channel-sync (канал + видео, батчинг), localization read model + XLSX export (Phase 3), Web UI (Manual/Rules/Sync/Localizations), API routes (metadata/playlist/youtube/rules/run/channels/localizations), CLI (metadata/auth/playlist), MCP (metadata/playlist tools), 188 тестов.

**Запланировано, но не реализовано (Phase 4+):**
- CLI-команды и MCP-инструменты для синхронизации каналов/видео и для localization (`channel_sync`, `channel_list`, `video_list`, `localization_list`, `localization_export` и т.п.).
- XLSX **import** (экспорт уже есть — см. §2.8; импорт/валидация/change set — нет).
- Draft/change-set модель (`ChangeSet`, approval workflow).
- Пайплайн записи локализаций (`mergeLocalizations`, `buildSafeVideoUpdatePayload` для локализаций конкретно — сейчас есть только single-locale merge в `video-metadata/services.ts`, не полноценный localization-write pipeline).
- Durable backup / audit log / batch execution с ledger.
- Conflict detection между локальным кэшем и remote-состоянием (не нужен, пока нет draft-состояния — см. `docs/ARCHITECTURE.md` §4.5).
- Конфигурация целевых языков канала (сейчас язык — это только то, что уже есть в существующих локализациях; см. `docs/ARCHITECTURE.md` §5.4).

**Осознанно отложено (не входит в текущий MVP, см. `docs/PROJECT_SPEC.md` §58):**
YouTube Analytics, AI-генерация метаданных, publishing/upload видео, thumbnail-модуль, multi-user SaaS/RBAC, миграция БД-инструментария (Drizzle Kit) — до первого неаддитивного изменения схемы.

---

## 5. Замечание про безопасность записи (сквозной инвариант)

Единственный существующий write-путь для метаданных — `video-metadata/services.ts` → `applyMetadata` (identity check + guardrail + diff + опциональный dry-run, без backup/audit/verification — это уже задокументированный пробел в `docs/UPSTREAM_ANALYSIS.md` §7). Любой новый write-путь **обязан** проходить через `write-context.assertWriteChannel`, а не через собственную проверку канала.
