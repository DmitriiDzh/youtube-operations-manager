> Moved verbatim from SYSTEM_MAP.md §4 on 2026-11-17; index: ../SYSTEM_MAP.md

## 4. Статус компонентов

### 2.9bs vidIQ (BL-278, ADR 0077) — **этап 1 IMPLEMENTED на ветке `feature/vidiq-integration`, не влито**
- Шлюз `src/lib/vidiq-gateway/`, модуль `src/lib/vidiq-research/`, ключ в слоте `vidiq` (только Мак), журнал `vidiq_ledger` (v127),
  бюджет и снимок баланса, карточка в Настройки → Облачные API (подробно `docs/system/vidiq-research.md` §2.9bt). Платных
  потребителей нет; инструменты Продюсера, кэш и подвкладка Исследований — этапы 2–3 (**PLANNED**, не назначены).

### 2.9br2 Настройки публикации канала: статус (BL-279, ADR 0072 поправка 2) — **IMPLEMENTED на ветке** `feature/channel-publishing-defaults` (не в dev)
- Защита загрузки `publishing_settings_not_saved`, исправление категории (`package-category.ts`, владелец на «Главной» и
  `producer_video_category_fix`), проверка `producer_video_publishing_check` (Producer 1.35.0), перенос настроек канала на «Главную».
  Настоящий прогон на WWE (dry run, затем запись) — после мерджа, координатором. Строки, поставленные до сборки, не перепроверяются (RISK-160).

### 2.9bo2 Теги видео только на чтение (BL-273, FO-REQ-0056 часть 2) — **IMPLEMENTED** (dev, 24.11.2026)
- `channel_sync` сохраняет `snippet.tags` из уже читаемой части `snippet` (без доп. квоты) в `videos.tags_json` (schema v125; `NULL` —
  ещё не прочитаны, до следующего синка). Проверенная запись video-details (`video_details_update`, «Применить упаковку»,
  `producer_video_metadata_update`) сразу обновляет теги в локальной копии из read-back.
- MCP: поле `tags` в `channel_video_list` (выбирается в `fields`) и `metadata.tags` в `agent_get_video_context` (`[]` — тегов нет,
  `null` — ещё не прочитаны). Agent API 4.28.0, Producer API 1.30.0. Записей в YouTube и изменений писателей нет. Часть 1 запроса
  (локализации «О канале») вне рамок.

### 2.9bm2 Мелкие изменения 15.11 (без отдельного BL)
- Автозагрузка (private): список каналов, которые она пропускает (`auto_private_upload_paused_channels`, app_settings, этот компьютер;
  переключатели «По каналам» в карточке «Запись на YouTube»; owner TG 2298, WWE). Загрузки держат restart-when-idle только в окнах
  «последний кусок отправлен» и `finishing` (ADR 0049 поправка 1, owner msg 4420).
- Переводы описания канала: язык набора пишется в существующий ключ канала и сверяется по нему (`channelKeyForSetLanguage`: регистр,
  `_`/`-`, единственный ключ языка без региона; несколько — отказ `language_key_ambiguous`).
- Соцсети: Configuration ID Facebook Login for Business (необязательно, `config_id` вместо `scope`), файл в rupload одним телом,
  Instagram при подключении из ответа страницы, «Повторить» доступно удалённо. Instagram этого аккаунта принимает через API только
  короткие Reels (~≤20 с, 15.11) — Shorts в Instagram владелец пока выкладывает вручную.
- Автоочистка mp4 не удаляет Shorts (≤ 180 с на YouTube, ADR 0058 поправка).

### 2.9bn2 Ожидание долгих операций без токенов агента (BL-271, ADR 0075) — **IMPLEMENTED на ветке** `feature/bl-271-wait` (не в dev)
- Ядро `src/lib/operation-wait/` (чистое: `waitFor`, таймаут 50 с по умолчанию, зажим 1–240, ранний выход `restarting` /
  `server_stopping` / `blocked` / `not_in_review`, сигнал остановки процесса на globalThis — его взводит SIGTERM в `instrumentation.ts`).
  Порты целей — `src/composition/wait-targets.ts` поверх чтений модулей (загрузки, медиа-сессии/задачи, Gemini/speech/sound, запросы
  переводов, раскадровки и рендеры, перезапуск); чужой канал отвечает `not_found`, как отсутствующий id.
- MCP: `factory_wait` (Factory API 1.54.0), `agent_wait` (Agent API 4.25.0, через `WORKER_FACTORY_TOOLS` поверх закреплённых deps),
  `producer_wait` (Producer API 1.27.0, только `upload` и `restart`). Только чтение; не считаются MCP-активностью для restart-when-idle.
- CLI `npm run --silent wait -- <target> <id>` (`src/cli/wait.ts`): HTTP-клиент собственного эндпоинта по токену из `YTOM_TOKEN`, без БД;
  одна JSON-строка, коды 0/1/2, переживает перезапуск сервера. Не цели: недельная сборка (отложено), recode/rename (синхронные).
- Claude Code по умолчанию обрывает HTTP-вызов MCP через ~60 с (замер этапа 0): длиннее 50 с — только с `"timeout": 300000` в записи сервера.

### 2.9bm3 Английские субтитры длинных видео WWE (BL-269, ADR 0074) — **IMPLEMENTED на ветке** `feature/bl-269-video-captions` (не в dev)
- `src/lib/video-captions/` — единственный писатель дорожек субтитров (§M: ничего не импортирует из `publishing`): `captions.insert`
  одной английской дорожки и, только по явной перезаписи владельца/Продюсера (TG 4660), `captions.update` единственной английской
  стандартной дорожки (чужой или нашей). `captions.delete` нет нигде (инвентаризация шлюза), ASR не трогаются. Шлюз записи
  `captions.ts` (insert/update), чтения `listVideoCaptions` / `downloadVideoCaption` (бэкап перезаписи, 200 ед.) / `getVideoCaptionContext`
  (`fileDetails`: кадр). Учётные данные с `youtube.force-ssl` (нет — `captions_scope_missing`). Квота: вставка 550, перезапись 800.
- Пакет `yt-release-package/2` `captions: [{ language, file, name, sha256 }]`; `captionsProblems` (блокирующие `captions_missing` /
  `captions_invalid` + reason), переключатель канала `captionsEnabled` (настройки публикации, по умолчанию выкл.), только
  горизонтальное длинное видео (V-код).
- Шаг загрузки `captions` (`publishing/caption-step.ts`; после переводов, до обложки; никогда не перезаписывает; дата только после
  none/verified/already_present — проходит только дорожка `serving`), `checksPassed` плана учитывает его. Запись `Vn_youtube.json`:
  `videoSha256`, `videoSizeBytes`, `captions` (шаг record сохраняет записи другого компьютера; добавление отказывает
  `captions_upload_unfinished`, пока запись ещё первая).
- Уже загруженное видео: маршрут владельца `POST /api/channels/[channelId]/publishing/package-captions` (кнопки «Субтитры» →
  «Добавить» / «Перезаписать субтитры» на карточке слота «Плана» и в «⋯» → пакеты релизов; до BL-266 — «Ролики и релизы») и `producer_video_captions_add` (Producer API 1.26.0, CAPTIONS_WRITE);
  сервис `publishing/package-captions.ts`. Agent API 4.24.0, Factory API 1.53.0 (поля `captions`, коды проблем; `docs/interfaces.md`).

### 2.9bl2 Замена обложки загруженного видео (BL-255, ADR 0069) — **IMPLEMENTED** (dev 04bf5e08, a6ea8d43)
- `src/lib/video-thumbnails/` — единственный писатель обложки уже загруженного видео (`thumbnails.set` через шлюз записи): владелец
  (кнопка «Заменить обложку» в карточке видео «Контент» и под слотом «Плана недели» с видео) и Продюсер
  (`producer_video_thumbnail_replace`, Producer API 1.20.0), любое видео канала. Картинка — только из `04 Videos/` (JPEG/PNG ≤ 2 МБ,
  правило `readThumbnail`), пробный запуск, проверка принадлежности (`snippet.channelId`), отказ пока загрузка этого видео не поставила
  свою обложку (`isUploadThumbnailStepPending`), копия старой обложки (снимок `video_thumbnail`), проверка канала, Live writes, сверка,
  журнал (`source: video_thumbnails`), обновление `videos.thumbnails_json`. План, одобрение и пакет не трогаются.
- Маршрут владельца `GET/POST /api/channels/[channelId]/videos/[videoId]/thumbnail`; чтения шлюза `getVideoThumbnailState`,
  `downloadVideoThumbnailImage` (*.ytimg.com).

### 2.9bk Кросс-постинг в другие сети (BL-252, ADR 0068, `docs/roadmap/plans/CROSS_POSTING_PLAN.md`) — **этапы 1–2 IMPLEMENTED** (dev 72a9ae25, be7fecc6)
- `src/lib/social-gateway/` — единственный шлюз к API соцсетей (сейчас `meta.ts`: окно согласия, обмен кода на долгий токен,
  `/me/accounts` с привязанным Instagram); `inventory.test.ts` не пускает другие файлы к хостам Meta.
- `src/lib/cross-posting/` (модуль-фича): приложение Meta (App ID + App Secret, device secret `meta_app`), подключение канала
  (одноразовый `state` 15 мин, выбор страницы), `social_accounts` (v121, device-local, токен страницы запечатан ключом устройства).
- Маршруты `/api/social/*`: App Secret и отключение — только Mac; подключение — только с HTTPS-адреса Tailscale (Meta не
  принимает http://localhost). Карточка «Соцсети» в Настройки → Каналы.
  Кнопка «Проверить» (AC-XP-8): ответ Meta о токене (действует, разрешения, страница, Instagram) против сохранённого.
- **Этап 2 (dev be7fecc6):** публикация идёт по слоту плана недели — блок `crossPost` в манифесте `yt-release-package/2`, одно
  одобрение владельца покрывает YouTube и соцсети (SHA-256 манифеста; sha256 видео обязателен). `publishing-plans`
  `socialSlotStates` (одобрение/вето/выпуск по отдельности, только этап packaged); `src/composition/cross-posting-plan.ts` +
  `cross-posting-runner.ts` (один исполнитель на процесс, тик раз в минуту из instrumentation; повторная проверка одобрения — `cross-posting-approval.ts`). Шлюз: Instagram Reels
  (resumable, `rupload.facebook.com`) и Reels страницы, `is_ai_generated`; каждый изменяющий вызов — за переключателем
  «Публикация в соцсети» (app_settings, выкл. по умолчанию, только Mac). Задания `social_post_jobs` (v122, device-local):
  uploading → processing → published/failed, без повторной публикации при обрыве; лимиты 24 ч (AC-XP-16); загрузка держит
  restart-when-idle. «План недели» показывает под слотом сети, тексты и проблемы. TikTok/Pinterest на паузе.
- **Независимость сетей (ADR 0068 поправка 2, владелец TG 4779, ветка `feature/cross-post-network-isolation`):** проверка
  личности (AC-XP-8) по каждой сети отдельно — `checkAccounts().networks`, `postingTarget(channelId, network)`; проблема только
  Instagram (`instagram_unlinked`/`_mismatch`/`_unreadable`, его разрешения, квота, загрузка, `missed_window`) не останавливает
  Facebook; `token_invalid`/`page_mismatch` (общий токен страницы) останавливают обе. Исполнитель: своя «полоса» на сеть
  (параллельно, ошибка шага не прерывает проход), проверка сети до квоты, у задания — код своей сети (`not_connected`, если
  аккаунта сети нет). Карточка «Соцсети» показывает итог по каждой сети.
- **Повтор владельца (TG 4780):** «Повторить» в веб-интерфейсе больше не удаляет задание, а ставит отметку
  `social_post_jobs.owner_retry_at` (v123, аддитивно, device-local); исполнитель публикует такое задание даже позже 12 ч окна
  (слот этой задачи читается и старше 36 ч, `socialSlotStates(…, { alsoSlotIds })`), с теми же проверками одобрения, личности
  сети, квоты и sha256; задание с отправленным вызовом публикации не повторяется (отметка ставится условным UPDATE). Не раньше
  запланированного времени слота; отметка снимается со своим кодом, если повтор выполнить нельзя (`retry_slot_not_approved`,
  `retry_blocked`, код проверки сети, `retry_expired` через 48 ч); при исчерпанной квоте ждёт (`retry_waiting_quota`). Instagram
  читается отдельным запросом от страницы: его сбой останавливает только Instagram; `profile_id` из `debug_token` сверяется со
  страницей. Автоматический поздний старт — по-прежнему `missed_window`. У агентов такого инструмента нет.

### 2.9bj YT Manager на телефоне (BL-254, `docs/roadmap/plans/MOBILE_UI_PLAN.md`) — **этап 1 IMPLEMENTED** (dev b38a79f4)
- Ниже 768 px: `AppShell` прячет боковое меню (`max-md:hidden`), внизу `PhoneNav` (Главная · Контент · Медиа · Аналитика ·
  «Ещё» — лист с остальными разделами и выходом; Escape закрывает, фокус возвращается), шапка компактная и липкая; вкладки
  разделов `.ytom-tabrow` листаются в одну строку; поля ввода 16 px — всё в `@media (max-width: 767.98px)`. `src/app/manifest.ts`,
  `public/icons/ytm-*.png`, `appleWebApp`, viewport cover, цвет темы только на телефоне. Десктоп не меняется. Этапы 2–4 впереди.

### 2.9bi Доступ с других устройств владельца через Tailscale (BL-251, ADR 0067, `docs/roadmap/plans/REMOTE_ACCESS_PLAN.md`) — **IMPLEMENTED, влито в `dev` (df9c1189), live 14.11; статусы оболочки с телефона — f88cde6f (ADR 0067 поправка 1)**
- Сервер по-прежнему слушает 127.0.0.1; `tailscale serve` (`scripts/macos/remote-access.sh enable|disable|status`) отдаёт его в
  личную сеть владельца по HTTPS. Никакого LAN и Funnel.
- `src/lib/loopback-guard`: запрос с заголовками прокси (`X-Forwarded-*`, `Forwarded`, `Tailscale-User-*`) — всегда удалённый,
  никогда не loopback (MCP и loopback-only маршруты остаются только для Mac). `src/proxy.ts` теперь видит и страницы: для
  удалённых запросов — переключатель, Mac-only маршруты, проверка Origin, эпоха сессии, закреплённый логин Tailscale.
- `src/lib/remote-access/` (модуль-фича): переключатель, пароль (scrypt), блокировка, эпоха; состояние в
  `<app data>/remote-access.json` (не в базе, передача устройства его не переносит). NextAuth `remote-password` в `auth.ts`.
  Карточка «Доступ с других устройств» в Настройки → Общие; форма пароля на странице входа на удалённом хосте.

### 4.0 Ключевые ограничения (не путать с «не реализовано» — это активные инварианты, которые должен знать любой агент, прежде чем предлагать write-функциональность)

- **Approval ≠ применено к YouTube.** `Change.approvalStatus === "approved"` — это только локальная запись в SQLite (`docs/ARCHITECTURE.md` §6.9). Ни один код-путь в `src/lib/changesets/` не вызывает `googleapis`.
- **Conflict detection в Phase 4 сверяется с последним синхронизированным SQLite-снимком, а не с живым состоянием YouTube.** Свежая проверка remote-состояния непосредственно перед записью обязательна для Phase 5 (`docs/TECHNICAL_DEBT.md` RISK-03).
- **Приложение работает по модели single-operator.** Полноценной per-user/multi-tenant модели (ролей, разделения данных между людьми) по-прежнему нет — это осознанное допущение для локального инструмента. Но с 2026-09-20 каждое канало-зависимое чтение (Web/MCP/CLI) фильтруется по активному каналу вызывающего (`docs/decisions/0004-active-channel-read-scoping.md`), что закрывает конкретную утечку "любая сессия видит все локально известные каналы" — `docs/TECHNICAL_DEBT.md` RISK-02 теперь FIXED; RISK-39 (явный `channelId` в syncChannel без проверки владения) остаётся отдельным открытым пунктом.
- **CLI-интерфейсов для Change Set/Batch/channel-sync не существует отдельно от той же MCP-версии; и MCP, и CLI покрывают весь read/propose/create слой** (`changeset_list`/`changeset_get`/`localization_import_preview`/`changeset_create_from_import`/`batch_list`/`batch_get`/`channel_sync`/`channel_list`/`channel_video_list`/`ai_localization_generate`/`ai_localization_create_change_set`, см. §2.12/§2.13; `docs/TECHNICAL_DEBT.md` RISK-04, PARTIALLY RESOLVED) — approve/reject/execute для Change Set/Batch по-прежнему доступны только через Web UI/API (создание Change Set — из XLSX и теперь также из AI-генерации — через MCP/CLI уже есть).
- **Живая browser/OAuth-проверка не выполнена независимо** (`docs/TECHNICAL_DEBT.md` RISK-05) — автоматические тесты и один сквозной прогон на реальной БД/реальном экспорте существуют, но реального клика в браузере с настоящей Google-сессией не было.

**Реализовано и работает (проверено тестами):**
Auth (Web + CLI PKCE/device flow), credential resolution, write-context guardrail, YouTube client layer (read + write методы для metadata/playlist), persistence (`users`, `rules`, `channels`, `videos`, `change_sets`, `changes`, `batches`, `batch_ledger_rows`, `batch_attempts`, `video_execution_locks`, `audit_events`), channel-sync (канал + видео, батчинг), localization read model + XLSX export (Phase 3), **XLSX import + draft state + change sets + field-level diff + local approve/reject + conflict detection (Phase 4)**, **Batch/ledger/attempt data model, concurrency locks, safety preparation (identity/approval/fresh-fetch/conflict/backup/merge/dry-run), retry+reconciliation+verification, durable audit, crash recovery, item-level/systemic isolation (Phase 5, Slices 1-3 — см. 2.9a; реального `videos.update` по-прежнему нигде нет)**, Web UI (Manual/Rules/Sync/Localizations, включая Import и Change Set Review), API routes (metadata/playlist/youtube/rules/run/channels/localizations/change-sets), CLI (metadata/auth/playlist), MCP (metadata/playlist tools).

**Примечание:** этот абзац не обновлялся при добавлении Phase 6 (AI Localization/Connections, см. §2.9b/§2.9c) и не входит в рамки настоящей задачи для полной ревизии — актуальный, полный статус см. §2 целиком и `docs/ROADMAP_STATUS.md`. **Добавлено (Pre-Release Cross-Platform Persistence, см. §2.16):** платформо-зависимые пути (`src/lib/platform-paths`), версионирование схемы (`src/lib/schema-versioning`, `docs/decisions/0002-*.md`), device-локальный lock (`src/lib/operation-lock`), scrub-and-checksum снапшот-пайплайн (`src/lib/snapshot`), device handoff с restricted recovery mode (`src/lib/device-handoff`), единый choke-point для Web (`src/proxy.ts`)/CLI/MCP. 448 тестов на момент завершения этой задачи (`npm test`).

**Запланировано, но не реализовано (Phase 5, Slice 4 — единственное оставшееся):**
- Реальный YouTube-адаптер за портом `WriteExecutor` — Slices 1-3 построили весь pipeline (ledger/attempt/retry/reconciliation/verification/audit/recovery/isolation) поверх абстрактного порта; ни один approved change по-прежнему не отправляется в YouTube ни при каких обстоятельствах.
- CLI-команды для синхронизации каналов/видео, localization и change sets/batches (`channel_sync`, `channel_list`, `video_list`, `localization_list`, `localization_export`, `changeset_approve` и т.п.) — MCP read/propose-инструменты для всего этого уже есть (§2.13, включая `channel_sync`), CLI-паритета и MCP apply-класса пока нет.
- Конфигурация целевых языков канала (сейчас язык — это только то, что уже есть в существующих локализациях; см. `docs/ARCHITECTURE.md` §5.4).
- Явная модель deletion-предложений (осознанно отложена в Phase 4, см. `docs/ARCHITECTURE.md` §6.14).
- AI-генерация локализаций (провайдер-агностичный интерфейс, драфты через тот же approval pipeline).

**Осознанно отложено (не входит в текущий MVP, см. `docs/PROJECT_SPEC.md` §58):**
AI-генерация метаданных, publishing/upload видео, thumbnail-модуль, multi-user SaaS/RBAC, миграция БД-инструментария (Drizzle Kit) — до первого неаддитивного изменения схемы. **YouTube Analytics больше не в этом списке** — реализовано (Phase 8, §2.9i; Studio-Parity S6b Overview, §2.9n); этот абзац не обновлялся с момента Phase 6 (см. предупреждение выше), актуальный статус — §2 целиком.

---
