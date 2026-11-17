> Moved verbatim from SYSTEM_MAP.md §2 on 2026-11-17; index: ../SYSTEM_MAP.md

### 2.1 Authentication / OAuth — **IMPLEMENTED**

- **Ответственность:** Google OAuth (веб-сессия через NextAuth + CLI/MCP через PKCE-loopback или device flow).
- **Файлы:** `src/lib/auth.ts` (`authOptions`, `YOUTUBE_SCOPES`, `buildGoogleLoopbackAuthUrl`, `startGoogleDeviceAuthorization`, `pollGoogleDeviceAuthorizationToken`, `exchangeGoogleAuthCode`, `revokeGoogleToken`), `src/app/api/auth/[...nextauth]/route.ts`.
- **Точки входа:** веб — `getServerSession(authOptions)` в каждом API route handler; CLI — `npm run cli:video-metadata -- auth login [--device]`.
- **Зависимости:** `src/lib/db.ts` (сохранение токенов в `users`).
- **Read/Write:** сама по себе не пишет в YouTube; получает/обновляет OAuth-токены.
- **Важные ограничения безопасности:** access/refresh токены никогда не логируются и не уходят в браузерный JS; хранение — только на сервере/локально.
- **Phase 8, BL-056 (2026-09-22, owner approval, Telegram msg 356):** `YOUTUBE_SCOPES` расширен новым `YOUTUBE_ANALYTICS_READ_SCOPE` (`yt-analytics.readonly`) — read-only доступ к YouTube Analytics API, нужен для Phase 8's Analytics-адаптера (BL-057, ещё не реализован). Не включает `yt-analytics-monetary.readonly` (доходные метрики) — отдельный, не запрошенный и не одобренный scope. **Re-consent не потребовал отдельного механизма**: все три существующих пути входа (`buildGoogleLoopbackAuthUrl`, NextAuth `authOptions`, `startGoogleDeviceAuthorization`) уже безусловно используют `prompt: "select_account consent"`/полный consent на каждом входе — новый scope просто появится на экране согласия при следующем входе любого пользователя. Уже сохранённый токен существующей сессии не получает новый scope автоматически (нужен повторный вход) — это и есть fail-closed поведение: `resolveGoogleCredentials`'s `requiredScopes`-проверка (уже существующая, ничего нового) отклонит вызов Analytics-адаптера с `AUTH_SCOPE_INSUFFICIENT`, пока пользователь не переавторизуется. Реальная переавторизация настоящего Google-аккаунта не выполнялась агентом (не может быть выполнена автоматически) — владелец должен провести её сам.

### 2.2 Credential resolution — **IMPLEMENTED**

- **Ответственность:** превращение `CredentialRef` (`{ userId }` или явные токены) в `ResolvedCredentials` с проверкой достаточности OAuth-скоупов и автообновлением истёкшего access token.
- **Файлы:** `src/lib/video-metadata/adapters/google-auth.ts` (`resolveGoogleCredentials`, используется всеми доменными модулями, включая `channel-sync`), `src/lib/cli-auth/*` (для CLI/MCP: contracts/schemas/services/adapters/index паттерн — `services.ts`, `adapters/active-auth-storage.ts` — файл `data/auth-context.json` с активным локальным пользователем, `contracts.ts` — типизированные коды ошибок `AUTH_*` и доменные типы).
- **Точки входа:** `authResolver.resolve({ credentialRef, requiredScopes })` — вызывается из `services.ts` каждого доменного модуля.
- **Зависимости:** `src/lib/db.ts` (чтение/обновление токенов), `src/lib/auth.ts` (OAuth2-клиент).
- **Read/Write:** может обновлять (refresh) и персистить токены; не пишет в YouTube.
- **Важные ограничения безопасности:** несоответствие требуемых скоупов → `AUTH_SCOPE_INSUFFICIENT`; истёкший токен без refresh token → `AUTH_REFRESH_TOKEN_MISSING`; отсутствие локального пользователя (CLI/MCP) → `AUTH_USER_NOT_FOUND`.

### 2.3 Channel identity / write-context guardrails — **IMPLEMENTED**

- **Ответственность:** единственная реализация проверки `expectedChannelId` — блокирует write-операции, если активный OAuth-канал не совпадает с ожидаемым (fail-closed).
- **Файлы:** `src/lib/write-context/contracts.ts`, `service.ts` (`assertWriteChannel`, `getWriteChannelContext`, `listKnownChannels`, `selectWriteChannel`), `adapters/youtube-api.ts`.
- **Точки входа:** `writeContext.assertWriteChannel({ credentialRef, credentials, expectedChannelId })` — вызывается из `video-metadata/services.ts` (`applyMetadata`) и `playlist-management/services.ts` (create/update/delete/**addVideosToPlaylist/removeVideosFromPlaylist**). **Исправлено 2026-09-26 (независимый аудит тестов):** add/removeVideosToPlaylist раньше вообще не вызывали этот guardrail, в отличие от всех соседних write-методов в том же файле — доступно через Web/CLI/MCP. Оба метода теперь получили ту же проверку принадлежности плейлиста активному каналу (через `getPlaylistForUpdate`), что уже была у update/delete; `expectedChannelId` стал обязательным полем в `playlistAddVideosInputSchema`/`playlistRemoveVideosInputSchema` (было её вообще не было).
- **Зависимости:** `src/lib/db.ts` (`getSelectedChannelId`/`setSelectedChannelId` — персистентный выбор канала).
- **Read/Write:** сам guardrail не пишет в YouTube; используется исключительно перед write-вызовами.
- **Важные ограничения безопасности:** несовпадение → `WRITE_CHANNEL_MISMATCH`; невозможность определить активный канал → `WRITE_CHANNEL_UNRESOLVED`; отсутствие `expectedChannelId` → `WRITE_CHANNEL_REQUIRED`. **`channel-sync` (Phase 2) этот guardrail не использует — синхронизация read-only и не нуждается в проверке канала записи** (см. `docs/ARCHITECTURE.md` §4.3).

### 2.15 Configuration / local state — **IMPLEMENTED**

- **Ответственность:** переменные окружения и локальные файлы состояния.
- **Файлы:** `.env.local` (не в репозитории; обязательные `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`; опциональные `CLI_OAUTH_CALLBACK_PORT`, `YOUTUBE_TRANSCRIPT_PROVIDER`, `METADATA_GENERATOR_MODE`, `METADATA_GENERATOR_RAW_OUTPUT`, и (Phase 6) `AI_CONNECTIONS_ENCRYPTION_KEY` — base64-encoded 32-byte AES-256-GCM key; без неё AI Connections с credential сохранить нельзя, plaintext-фолбэка нет; и (см. §2.9j, не в `dev`) `CLOUD_CONNECTION_ENCRYPTION_KEY` — та же схема, намеренно отдельный ключ от `AI_CONNECTIONS_ENCRYPTION_KEY`, плюс требует добавления `http://localhost:3000/api/cloud-connection/callback` в Authorized redirect URIs OAuth-клиента в Google Cloud Console). **Обновлено (Pre-Release Cross-Platform Persistence, см. §2.16):** `playlist-manager.db`/`auth-context.json`/`backups/` больше не живут в `<repo>/data/` — они находятся в платформо-зависимой app-data директории (`src/lib/platform-paths`, `resolveAppPaths`): Windows — `%APPDATA%\YouTubeOperationsManager\`, macOS — `~/Library/Application Support/YouTubeOperationsManager/`. `<repo>/data/playlist-manager.db` остаётся действительным только как одноразовый источник миграции при первом запуске на новой машине (никогда не изменяется, никогда не удаляется).
- **Важные ограничения безопасности:** `data/*.db`, `data/auth-context.json`, `data/oauth/`, `data/tokens/`, `credentials/`, `.env*` — всё в `.gitignore` (актуально и для legacy-расположения, и для новой app-data директории, которая физически вне репозитория). Секреты никогда не попадают в логи или к AI-провайдеру. AI-connection credential шифруется отдельно от этого — см. §2.9c.

---

