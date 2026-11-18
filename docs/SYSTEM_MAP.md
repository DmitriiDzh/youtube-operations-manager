Read this index whole; open only the subsystem file you touch.

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
YouTube Read Gateway (src/lib/youtube-read-gateway/, googleapis) + Write Gateway (src/lib/youtube-write-gateway/)         Database (src/lib/db.ts, SQLite/libSQL)
```

Все четыре интерфейса (Web/CLI/MCP/API) вызывают одни и те же core-фабрики (`createVideoMetadataCore()`, `createPlaylistManagementCore()`, `createChannelSyncCore()`) — ни один интерфейс не реализует свою собственную логику работы с YouTube API или свои проверки безопасности записи.

---

## 2. Подсистемы

Каждая строка — один подраздел §2: он перенесён дословно, с тем же заголовком и номером, в файл из последней колонки (перенос 2026-11-17, `docs/roadmap/plans/DOCS_SPLIT_PLAN.md`). `§2.9am` ищется по номеру в этой таблице; вторые 2.9w/2.9x/2.9ap названы 2.9w2/2.9x2/2.9ap2. Новый подраздел — новая строка здесь и запись в файле домена.

| № | Подсистема | Статус | Файл |
|---|---|---|---|
| 2.1 | Authentication / OAuth | IMPLEMENTED | `docs/system/auth-identity.md` |
| 2.2 | Credential resolution | IMPLEMENTED | `docs/system/auth-identity.md` |
| 2.3 | Channel identity / write-context guardrails | IMPLEMENTED | `docs/system/auth-identity.md` |
| 2.4 | YouTube API client layer | IMPLEMENTED | `docs/system/youtube-gateways.md` |
| 2.5 | Persistence / database | IMPLEMENTED | `docs/system/persistence-tests.md` |
| 2.6 | Channel synchronization | IMPLEMENTED | `docs/system/channel-video-sync.md` |
| 2.7 | Video synchronization | IMPLEMENTED | `docs/system/channel-video-sync.md` |
| 2.8 | Localization-related read model | IMPLEMENTED | `docs/system/localization.md` |
| 2.9 | Change sets / XLSX import / diff & approval | IMPLEMENTED | `docs/system/changesets-batches.md` |
| 2.9a | Batch execution ledger + safety preparation + recovery/audit + write… | PARTIALLY IMPLEMENTED | `docs/system/changesets-batches.md` |
| 2.9b | AI Localization | IMPLEMENTED for the mock-provider verti… | `docs/system/ai-localization.md` |
| 2.9c | AI Connections | IMPLEMENTED for the OpenAI-compatible p… | `docs/system/ai-localization.md` |
| 2.9d | Video Details | IMPLEMENTED, module + API + Content-tab… | `docs/system/video-details.md` |
| 2.9e | Video detail popup | IMPLEMENTED | `docs/system/video-details.md` |
| 2.9f | Live-writes / Gate B toggle + MCP connection toggle | IMPLEMENTED | `docs/system/youtube-gateways.md` |
| 2.9g | Единый шлюз записи в YouTube | IMPLEMENTED | `docs/system/youtube-gateways.md` |
| 2.9h | Automerge draft layer + multi-device sync | IMPLEMENTED for the scope below | `docs/system/device-sync.md` |
| 2.9i | Phase 8 | IMPLEMENTED | `docs/system/analytics.md` |
| 2.9j | Cloud connection | IMPLEMENTED | `docs/system/cloud.md` |
| 2.9k | Счётчики трафика шлюзов | IMPLEMENTED | `docs/system/youtube-gateways.md` |
| 2.9l | Cloud Quotas | IMPLEMENTED | `docs/system/cloud.md` |
| 2.9m | Sync Gateway generalization: `automerge-core`, editorial-profile + ai… | IMPLEMENTED | `docs/system/device-sync.md` |
| 2.9n | Studio-Parity S6b | IMPLEMENTED | `docs/system/analytics.md` |
| 2.9o | Phase 8 follow-up: MCP/CLI аналитика для агентов + диагностика пробел… | IMPLEMENTED | `docs/system/analytics.md` |
| 2.9p | Phase 8 follow-up, слайс 3/4: сравнение видео по сопоставимому возрас… | IMPLEMENTED | `docs/system/analytics.md` |
| 2.9q | Phase 8 follow-up, слайс 4/4: еженедельные аналитические отчёты | IMPLEMENTED | `docs/system/analytics.md` |
| 2.9r | Agent Operations Interface | CODE-COMPLETE, смержено в `dev` | `docs/system/agent-operations.md` |
| 2.9s | Зоны ответственности агентов | RETIRED в Phase 12 | `docs/system/agent-operations.md` |
| 2.9t | Studio-Parity deep-parity: Content/Audience под-вкладки Analytics | IMPLEMENTED, в `dev` | `docs/system/analytics.md` |
| 2.9u | Общий модуль XLSX-ввода/вывода | IMPLEMENTED | `docs/system/localization.md` |
| 2.9v | Market Intelligence | IMPLEMENTED для описанного ниже объёма | `docs/system/market-intelligence.md` |
| 2.9w | Decision & Experiment Engine | IMPLEMENTED для описанного ниже объёма | `docs/system/decision-engine.md` |
| 2.9x | Channel Workspaces | IMPLEMENTED, в `dev` | `docs/system/channel-workspaces.md` |
| 2.9y | Изоляция агентов по каналам | IMPLEMENTED, в `dev` | `docs/system/agent-operations.md` |
| 2.9w2 | Phase 13 | IMPLEMENTED | `docs/system/channel-workspaces.md` |
| 2.9x2 | Phase 14 | PARTIALLY IMPLEMENTED | `docs/system/media-generation.md` |
| 2.9aa | Доступ Factory Operator: реестр логических путей и вторая роль агента | IMPLEMENTED, в `dev` (`ada77c5`) | `docs/system/agent-operations.md` |
| 2.10 | Web UI | IMPLEMENTED | `docs/system/web-ui.md` |
| 2.11 | API routes | IMPLEMENTED | `docs/system/interfaces.md` |
| 2.12 | CLI | IMPLEMENTED | `docs/system/interfaces.md` |
| 2.13 | MCP | IMPLEMENTED | `docs/system/interfaces.md` |
| 2.14 | Tests | IMPLEMENTED | `docs/system/persistence-tests.md` |
| 2.15 | Configuration / local state | IMPLEMENTED | `docs/system/auth-identity.md` |
| 2.16a | Automatic device sync | IMPLEMENTED | `docs/system/device-sync.md` |
| 2.16 | Cross-Platform Persistence & Device Handoff | IMPLEMENTED for the scope below | `docs/system/device-sync.md` |
| 2.9ab | Общие токены агентов и роль Producer | IMPLEMENTED, на ветке `feature/producer… | `docs/system/agent-operations.md` |
| 2.9ac | Гигиена списка наблюдения и предложения агентов | IMPLEMENTED, на ветке `feature/watchlis… | `docs/system/market-intelligence.md` |
| 2.9ad | Вехи 7-го и 28-го дня по своим роликам | IMPLEMENTED, на ветке `feature/fo-req-0… | `docs/system/analytics-stored-data.md` |
| 2.9ae | Источники трафика и устройства по дням | IMPLEMENTED, влито в `dev` (`2f98796`) | `docs/system/analytics-stored-data.md` |
| 2.9af | Поисковые запросы по роликам и неделям канала | IMPLEMENTED, влито в `dev` (`30ce7bc`) | `docs/system/analytics-stored-data.md` |
| 2.9ap | Источники «Рекомендуемые видео» по роликам и неделям канала | IMPLEMENTED, влито в `dev` (`f5fe622`) | `docs/system/analytics-stored-data.md` |
| 2.9ag | Варианты эксперимента на роликах | IMPLEMENTED, влито в `dev` (`6cb7999`) | `docs/system/decision-engine.md` |
| 2.9ah | Комментарии к своим роликам | IMPLEMENTED, влито в `dev` (`0fe5183`) | `docs/system/analytics-stored-data.md` |
| 2.9al | Просмотр сгенерированных картинок и видео в Media → Review, фаза 1 | IMPLEMENTED, влито в `dev` (`a07b778`) | `docs/system/media-review.md` |
| 2.9ap2 | Облачные API вместе: одна вкладка, карточка Gemini в «Серверах», общи… | IMPLEMENTED на `feature/bl-193-cloud-ap… | `docs/system/cloud.md` |
| 2.9ao | Раскадровки до видео и вкладки Медиа по видам | IMPLEMENTED, влито в `dev` 2026-10-13 (… | `docs/system/media-review.md` |
| 2.9aq | Номера роликов и стоимость визуала каждого ролика | IMPLEMENTED на ветке `feature/bl-194-vi… | `docs/system/video-costs.md` |
| 2.9an | Публикация из YT Manager: загрузка, календарь, напоминание | этапы 0–1 IMPLEMENTED, влиты в `dev` 20… | `docs/system/publishing.md` |
| 2.9am | Круглосуточная трансляция своих открытых видео канала | IMPLEMENTED, влито в `dev` (`1c102a2`);… | `docs/system/live-streams.md` |
| 2.9ak | Картинки и видео через Gemini API под управлением оператора | IMPLEMENTED, влито в `dev` (`e72502e`) | `docs/system/media-generation.md` |
| 2.9aj | Повторные проверки оценённых треков | IMPLEMENTED, влито в `dev` (`77a915d`) | `docs/system/media-review.md` |
| 2.9ai | Наличие GPU по дата-центрам RunPod | IMPLEMENTED, влито в `dev` (`12e632a`) | `docs/system/media-generation.md` |
| 2.9ax | Статистика доступности GPU и журнал ожидания сессий | IMPLEMENTED на ветке `feature/fo-req-00… | `docs/system/media-generation.md` |
| 2.9z | Impressions и CTR через YouTube Reporting API | реализовано, слито в `dev` (`b1456c9`);… | `docs/system/analytics.md` |
| 2.9ar | Интерфейс всегда показывает, что происходит | IMPLEMENTED | `docs/system/web-ui.md` |
| 2.9as | Перезагрузка страницы не повторяет работу старта | IMPLEMENTED | `docs/system/web-ui.md` |
| 2.9at | Экраны не тратят квоту на уже сохранённые данные | IMPLEMENTED | `docs/system/youtube-gateways.md` |
| 2.9au | Несколько наборов изменений одним пакетом, вкладка «Записаны в YouTub… | IMPLEMENTED | `docs/system/changesets-batches.md` |
| 2.9ay | Проверка переводов по видео, проверки и отчёты агента | IMPLEMENTED (этапы 1–3) на ветке `featu… | `docs/system/localization.md` |
| 2.9az | Библиотека музыки по жанрам и оценка партий | IMPLEMENTED, влито в `dev` 2026-10-27;… | `docs/system/media-review.md` |
| 2.9av | Одно хранилище секретов компьютера и скачивание моделей из закрытых р… | IMPLEMENTED | `docs/system/media-generation.md` |
| 2.9aw | Среды пода, которыми управляет Оператор | IMPLEMENTED | `docs/system/media-generation.md` |
| 2.9ba | Разовые одобрения платных вызовов через тему «System» группы HUB | IMPLEMENTED, влито в `dev` 2026-10-27 (… | `docs/system/agent-operations.md` |
| 2.9bb | Закрытые репозитории GitHub в средах пода | IMPLEMENTED, влито в `dev` 2026-10-27 (… | `docs/system/media-generation.md` |
| 2.9bc | «Собрать неделю»: сборка недели фабрики из Web UI | IMPLEMENTED на ветке `feature/bl-231-bu… | `docs/system/publishing.md` |
| 2.9bd | Речь голосами канала: Gemini TTS, реестр голосов, ElevenLabs | IMPLEMENTED на ветке `feature/bl-236-su… | `docs/system/media-review.md` |
| 2.9be | Гигиена диска: временные папки тестов, кэш сборки, резервные копии ми… | IMPLEMENTED на ветке `feature/bl-237-di… | `docs/system/disk-hygiene.md` |
| 2.9bf | Удаление локального mp4 после загрузки | IMPLEMENTED на ветке `feature/fo-req-00… | `docs/system/publishing.md` |
| 2.9bg | Клипы на проверку | IMPLEMENTED | `docs/system/media-review.md` |
| 2.9bl | Проверка владельцем итогового пакета | IMPLEMENTED на ветке | `docs/system/publishing.md` |
| 2.9bn | Шаблон недели вместо одобрения слотов | IMPLEMENTED на ветке | `docs/system/publishing.md` |
| 2.9bm | Ворота только по медиа и правка упаковки после загрузки | IMPLEMENTED на ветке | `docs/system/publishing.md` |
| 2.9bh | Решения владельца будят Продюсера | IMPLEMENTED, влито в `dev` (`b598da19`) | `docs/system/agent-operations.md` |
| 2.9bo2 | Теги видео только на чтение | IMPLEMENTED на ветке | `docs/system/component-status.md` |
| 2.9bm2 | Мелкие изменения 15.11 | — | `docs/system/component-status.md` |
| 2.9bn2 | Ожидание долгих операций без токенов агента | IMPLEMENTED на ветке | `docs/system/component-status.md` |
| 2.9bm3 | Английские субтитры длинных видео WWE | IMPLEMENTED на ветке | `docs/system/component-status.md` |
| 2.9bl2 | Замена обложки загруженного видео | IMPLEMENTED | `docs/system/component-status.md` |
| 2.9bk | Кросс-постинг в другие сети | этапы 1–2 IMPLEMENTED | `docs/system/component-status.md` |
| 2.9bj | YT Manager на телефоне | этап 1 IMPLEMENTED | `docs/system/component-status.md` |
| 2.9bi | Доступ с других устройств владельца через Tailscale | IMPLEMENTED, влито в `dev` (df9c1189),… | `docs/system/component-status.md` |
| 4.0 | Ключевые ограничения | — | `docs/system/component-status.md` |
| 4 | Статус компонентов (весь §4, подразделы выше — его записи) | — | `docs/system/component-status.md` |

## 3. Где вносить изменения

| Задача | Где |
|---|---|
| Добавить новую read-операцию YouTube | Низкоуровневая функция в подходящем дочернем модуле `src/lib/youtube-read-gateway/` (`data-api.ts` для Data API v3), реэкспортированная через барьер `index.ts`, затем обёртка в `adapters/youtube-api.ts` нужного доменного модуля, импортирующая **только** из `@/lib/youtube-read-gateway` (**никогда** напрямую из `data-api.ts`). Зафиксировано `read-gateway-inventory.test.ts` и `docs/decisions/0007-youtube-read-gateway.md` |
| Добавить новую write-операцию YouTube (что угодно, что реально может изменить данные на YouTube) | Низкоуровневая функция в `src/lib/youtube-write-gateway/` (**никогда** в `youtube-read-gateway/` и **никогда** напрямую в адаптере доменного модуля) + вызов `assertLiveWritesAuthorized()` из шлюза непосредственно перед вызовом в самом адаптере, вызывающем шлюз. Единственный разрешённый путь, зафиксировано `gateway-inventory.test.ts` и `docs/decisions/0005-youtube-write-gateway.md` (см. §2.9g) |
| Добавить новый доменный модуль | Новая директория `src/lib/<module>/` с `contracts.ts` / `schemas.ts` / `services.ts` / `adapters/` / `index.ts` — по образцу `channel-sync/` или `playlist-management/` |
| Добавить новый API route | `src/app/api/<path>/route.ts`, переиспользуя `getVideoMetadataErrorStatus` и `parseVideoMetadataJsonBody` из `src/app/api/video-metadata/` |
| Добавить новую CLI-команду | Новый namespace/command в `src/cli/video-metadata.ts`, по образцу существующих `metadata`/`auth`/`playlist` |
| Добавить новый MCP-инструмент | `server.registerTool(...)` в `src/mcp/server.ts` + обработчик в `createMcpToolHandlers` |
| Добавить новую персистентную сущность | Новая `sqliteTable` + `CREATE TABLE IF NOT EXISTS` в `initializeDatabase()` внутри `src/lib/db.ts` (пока схема аддитивна — см. `docs/ARCHITECTURE.md` §6.2 про решение по миграциям) |
| Добавить новый safe write workflow | Переиспользовать `write-context.assertWriteChannel` (не копировать проверку); придерживаться модели identity check → validation → backup → diff → approval → dry-run → audit → verification из `docs/PROJECT_SPEC.md` |

---

## 4. Статус компонентов

Перенесён дословно в `docs/system/component-status.md` (20 КБ, список статусов по подсистемам и ключевые ограничения 4.0).

---

## 5. Замечание про безопасность записи (сквозной инвариант)

Единственный существующий write-путь для метаданных — `video-metadata/services.ts` → `applyMetadata` (identity check + guardrail + diff + опциональный dry-run, без backup/audit/verification — это известный, задокументированный пробел, см. `docs/TECHNICAL_DEBT.md` RISK-09). Любой новый write-путь **обязан** проходить через `write-context.assertWriteChannel`, а не через собственную проверку канала.
