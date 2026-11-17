> Moved verbatim from SYSTEM_MAP.md §2 on 2026-11-17; index: ../SYSTEM_MAP.md

### 2.9x Channel Workspaces — путь к рабочей папке канала на этом устройстве (Phase 11, `docs/roadmap/plans/PHASE_11_PLAN.md`) — **IMPLEMENTED, в `dev`** (`f15a8c3`)

- **Объём.** Узкий объём из `FUTURE_PHASES.md` §11. Оператор задаёт абсолютный локальный путь к рабочей папке отдельно для каждого подключённого канала и отдельно на каждом устройстве. Агент может прочитать эту строку. Приложение никогда не читает, не перечисляет и не пишет ничего внутри этого пути. Workflow Registry исключён из фазы. Глобальный operations workspace (§2.9r, слайс I) не менялся.
- **Модули.**
  - `src/lib/local-path-validation/` — общий модуль (`AGENTS.md` §M). В него без изменений перенесена проверка пути из слайса I: абсолютный, существует, это директория, не пересекается с app-data. `operations-instructions` реэкспортирует те же имена.
  - `src/lib/channel-workspaces/` — contracts/schemas/services/adapters/index.
- **Хранение.** Таблица `channel_workspaces` (SCHEMA_MIGRATIONS v33), ключ `(device_id, channel_id)` по `deviceId` из bootstrap-config. Все чтения фильтруются по текущему устройству. Таблица намеренно не входит в `SNAPSHOT_TRANSFERRED_TABLES` и в sync-gateway; причина записана в комментарии `snapshot/contracts.ts` и проверена тестом.
- **Интерфейсы.**
  - Оператор задаёт путь через `GET/PUT /api/channel-workspaces` и поле в каждой строке Settings → Channels (`channel-workspace-field.tsx`, в собственном `FeatureErrorBoundary`).
  - Агент читает через MCP `agent_get_channel_workspace` и CLI `agent channel-workspace`: только чтение, `assertActiveChannel`, без зонирования. Задать путь через MCP/CLI невозможно, это проверено механически.
  - `AGENT_API_VERSION` → `0.15.0`. Подробности — `docs/AGENT_OPERATIONS_INTERFACE.md` §4m.

### 2.9w2 Phase 13 — источники данных и правила YouTube API для Research — **IMPLEMENTED** (ветка `feature/phase-13-data-sources`)

- **Ответственность:** Research приведён к правилам YouTube API, решение D1=(a):
  - чужие данные из API хранятся ≤30 дней;
  - производные метрики по ним не вычисляются.

  Новая модель квот: у поиска свой лимит 100/день, сутки считаются по Тихоокеанскому времени. Добавлены дешёвые и бесплатные источники: RSS, `videos.batchGetStats`, Wikipedia Pageviews, чарт Music.
- **Модули:**
  - `src/lib/youtube-data-policy` — классификация таблиц и очистка;
  - `src/lib/youtube-quota` — квотные факты;
  - `youtube-read-gateway/feed.ts` — RSS;
  - `src/lib/wikipedia-gateway` и `src/lib/wikipedia-signals`.
- **Схема:** v37 (Wikipedia).
- **Настройки:** тумблеры «RSS feed reads» и «Wikipedia reads» в карточке чтения Settings → API.
- **Подробно:** ARCHITECTURE §24, план `docs/roadmap/plans/PHASE_13_PLAN.md`.
