> Index: ../SYSTEM_MAP.md

### 2.9br Исследование через vidIQ: шлюз, ключ, учёт кредитов и бюджет (BL-278, ADR 0077, `docs/roadmap/plans/VIDIQ_INTEGRATION_PLAN.md`) — **этап 1 IMPLEMENTED на ветке `feature/vidiq-integration`, не влито**

- **Шлюз `src/lib/vidiq-gateway/`** (единственный путь к MCP-серверу vidIQ `https://mcp.vidiq.com/mcp`, ключ API в `Authorization:
  Bearer`, без OAuth): `client.ts` (на каждую операцию свежий SDK `Client` + `StreamableHTTPClientTransport`, одна операция за раз на
  процесс через очередь на `globalThis`, 60 с), `contract.ts` (18 разрешённых инструментов, закреплённые цены и TTL, входные схемы из
  датированной фикстуры `fixtures/tools-list.2026-11-26.json`, правила аргументов), `index.ts` (барабан: `createVidiqGateway`,
  `getVidiqGateway`). Перед отправкой: инструмент в списке (`vidiq_tool_not_allowed`), только свойства закреплённой схемы
  (`vidiq_args_invalid`), канонические id каналов и видео (`vidiq_canonical_id_required`), `userGoal` вырезается; затем сверка с живым
  `tools/list` (держится час, перечитывается один раз перед отказом): `vidiq_tool_missing`, `vidiq_schema_drift`, `vidiq_cost_changed`,
  `vidiq_annotation_drift` (исключение — `vidiq_comment_insights`). Ошибки транспорта — фиксированные сообщения
  (`vidiq_key_invalid`, `vidiq_rate_limited`, `vidiq_unavailable`, `vidiq_outcome_unknown`, `vidiq_result_too_large` > 256 КБ).
  Счётчик трафика `vidiq_api`. Адрес — константа; подмена только на loopback (тесты). JSON Schema — через публичный экспорт SDK
  `@modelcontextprotocol/sdk/validation/ajv` (ajv 8 из SDK). Ответ, в котором встретился бы ключ, очищается от него.
- **Модуль `src/lib/vidiq-research/`** (`contracts`/`schemas`/`services`/`adapters`/`index`, единственный пользователь шлюза):
  выключатель `vidiq_enabled`, бюджет `vidiq_monthly_budget_credits` (по умолчанию 150, 0–100 000) и снимок баланса
  `vidiq_balance_snapshot` (привязан к версии ключа) в `app_settings` (локально для компьютера). Порядок вызова под одной блокировкой
  процесса: выключатель → ключ → проверки без сети (и id задания из своего журнала) → сверка с живым списком и переплата →
  заявленная цена → бюджет периода (`vidiq_budget_exhausted`) и баланс аккаунта (`vidiq_insufficient_credits`, перечитывается, если
  старше 10 мин) → строка `pending` → вызов → `_credits.used` и итог → бесплатное чтение баланса. Период — цикл vidIQ
  (`renewableResetsAt`), без снимка — календарный месяц UTC. Повторов нет. Фоновой работы нет.
- **Ключ:** слот device-secrets `vidiq` (подсказка — последние 4 символа), вводится только на Маке (`/api/vidiq/key` в
  `REMOTE_BLOCKED_PREFIXES`), сохраняется только после бесплатной проверки `vidiq_balance`; первое проверенное сохранение включает
  модуль, удаление ключа выключает и стирает снимок. В файл переноса облачных ключей не входит (owner TG 4961).
- **Журнал `vidiq_ledger`** (schema v127): время, вызывающий (`owner`/`producer`), инструмент, SHA-256 канонических аргументов,
  заявленная цена, `credits_used`, итог (`pending | ok | cache_hit | refused | failed | unknown | job_pending`), код ошибки, id задания,
  баланс после; 90 дней; только этот компьютер; `not_api_data`.
- **Маршруты** `src/app/api/vidiq/*` (сессия Web): `GET /api/vidiq`, `PUT`/`DELETE /api/vidiq/key`, `PATCH /api/vidiq/settings`,
  `POST /api/vidiq/balance`, `POST /api/vidiq/check`. **Карточка** «vidIQ» в Настройки → Облачные API (`vidiq-settings.tsx`,
  свой `FeatureErrorBoundary`): ключ (`MaskedSecretInput`), выключатель, статус, «Проверить подключение», баланс с «Обновить»,
  бюджет, 20 последних строк журнала. Тексты — область `vidiq` во всех языках.
- **Не в этапе 1:** инструменты Продюсера, кэш, переходы заданий `job_poll` (completed/failed/refunded), передача в список
  наблюдения, подвкладка «vidIQ» в Исследованиях (этапы 2–3, не назначены). Платных потребителей в этапе 1 нет.
