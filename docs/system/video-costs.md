> Moved verbatim from SYSTEM_MAP.md §2 on 2026-11-17; index: ../SYSTEM_MAP.md

### 2.9aq Номера роликов и стоимость визуала каждого ролика (BL-194 этапы 1–4, ADR 0040/0041, `docs/roadmap/plans/VIDEO_COST_PLAN.md`) — **IMPLEMENTED на ветке `feature/bl-194-video-cost`, не влито в `dev`**

- **Общий модуль `src/lib/video-projects/`** (§M: не импортирует модули-фичи, `boundaries.test.ts`): `numbering.ts` (следующий номер,
  список роликов, конфликты — чистые функции), `services.ts` (резерв, список, перенумерация проигравшего, отмена, `assertAttachable`,
  `resolveJobVideo`), `adapters/{store,workspace}.ts`.
- **Источники номера:** папки `04 Videos/<месяц>/<ММДД Vn>` (`workspace-videos.listVideoFolders`, пустые тоже), `video_registry.csv`,
  `publishing_uploads`, резервы всех компьютеров (отменённые тоже).
- **Между компьютерами:** таблица `video_reservations` (схема v95, только этот компьютер) и семейство синхронизации
  `video-reservations` (отчёт по устройству `ytm-video-reservations` v1, пиры не забываются). Дубликат: раньше взятый резерв
  выигрывает (при равенстве — меньший deviceId), проигравший берёт следующий номер только по выбору владельца; к спорному номеру
  ничего не привязывается (`video_in_dispute`).
- **Привязки:** `video` у раскадровки (документ Automerge), плана (`generation_plans.video`) и заданий (`media_jobs.video`,
  `gemini_media_jobs.video`); `videoNumber` при создании; без него задание наследует видео раскадровки, иначе плана; сбой модуля при
  наследовании — задание без привязки.
- **Factory API 1.20.0:** `factory_video_create`, `factory_video_list`, `factory_video_get_cost` (чтение), `videoNumber` у инструментов
  заданий, раскадровок и планов.
- **BL-263 (ADR 0071):** коды `S<n>` (шортсы; номер даёт фабрика, `factory_video_create.video`) рядом с `V<n>`; следующий V их не
  считает; состояние `recoded` + `recodedTo` у V, перекодированного в S (`factory_release_recode`); правила кода — `src/lib/shared-video-code/`.
- **Web/API:** `/api/channels/[channelId]/video-projects` (+ `/[video]/renumber`, `/[video]/cancel`), `.../storyboards/[id]/video`,
  `/api/generation-plans/[planId]/video`; Контент → «Публикация» → «Ролики в работе»; выбор ролика на экране раскадровки и в карточке плана.
- **Доля счёта RunPod (этап 2, ADR 0041):** `media_jobs.started_at` / `gpu_finished_at` из событий websocket ComfyUI
  (`jobs.ts` `recordTiming`); `media-generation/cost-split.ts` делит счёт закончившейся сессии по заданиям пропорционально секундам
  GPU (запуск и простой пода — в долях), в 1/10000 USD наибольшим остатком; пропущенное время оценивается (`estimated`). Хранится
  `gpu_seconds`, `allocated_usd`, `overhead_usd`, `allocation_basis`, `allocation_session_usd`. Цикл `video-costs` в
  `instrumentation.ts` раз в 5 минут (BL-270, было раз в минуту), старые сессии тоже; `publishAndRefresh` обходит каналы только при
  изменении чьих-либо запусков или раз в 30 минут.
- **Модуль `src/lib/video-costs/` (этап 3):** строки затрат этого компьютера (`db.ts`), отчёты других компьютеров, раскадровки
  (через sync-gateway) и состояния роликов (`video-projects`); его не импортирует ни один медиа-модуль, раскадровки и Публикация
  (`boundaries.test.ts`), Публикация и маршруты грузят его лениво. Семейство синхронизации `video-costs` (`ytm-video-costs` v1, по
  устройству; окно: отменённые ролики выпадают, опубликованные — 120 дней от запуска, непривязанные — 90). Итог запуска: выбран /
  отклонён / сбой / идёт / проба / только под. `Vn_cost.json` рядом с `Vn_release.json` на шаге записи загрузки; переписывает только
  компьютер, который его записал (`writtenBy`), если поздний отчёт изменил итог.
- **Старые запуски (этап 4):** предложение раскадровка→ролик, если её рендер — видеофайл папки «ММДД Vn» (имя и размер, затем
  sha256); привязка только по подтверждению владельца (или выбору вручную), ролик раскадровке ставит модуль раскадровок, затем
  привязываются непривязанные задания этого компьютера.
- **Маршруты:** `/api/channels/[channelId]/video-costs` (+ `/[video]`, `/backfill`, `/backfill/storyboards/[storyboardId]`,
  `/backfill/runs`); Контент → «Ролики в работе»: итог у ролика, окно запусков, «Старые запуски».
