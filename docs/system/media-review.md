> Moved verbatim from SYSTEM_MAP.md §2 on 2026-11-17; index: ../SYSTEM_MAP.md

### 2.9al Просмотр сгенерированных картинок и видео в Media → Review, фаза 1 (BL-175, FO-REQ-0018 §A–§D, `docs/roadmap/plans/VISUAL_REVIEW_PLAN.md`) — **IMPLEMENTED, влито в `dev` (`a07b778`)**

- **Выбор одного из N** (`src/lib/generation-plans/picks.ts`, чистые правила): выбор попытки и «ни один не подходит» — отдельно от оценок (v84: `generation_plan_picks` на компьютере плана, `generation_plan_peer_picks` — отправленные с этого компьютера). Цель выбора `pickTarget` (по умолчанию 1 для fixed, `targetCount` для until_accepted). Пункт решён — его попытки без оценки не ждут (`notChosen`) и не отклонены; выбранная считается принятой; отказ снимает выбор (свой, с другого компьютера, переданный фабрикой), выбрать отклонённую нельзя; выбор снимается и тогда, когда попытка уходит из очереди владельца (`left_queue`: строка этапа прямо перед проверкой валит её или отклоняет, пока план не показывает отклонённые; изменение плана — `reviewRejected` выключен, этап убран). Выбор действует только на попытке из очереди, которая считается (`pickableRefs`). Попытки только внешних этапов входят в `attempts` / `accepted` / `missing`. Одно правило «ждёт владельца» — `entryWaits`.
- **Метки:** у метки необязательная область `region { x, y, r }` (0..1) везде: оценки, строки отчёта, повторные проверки, отчёт между компьютерами.
- **Причины:** `reviewReasons` у плана и волны; иначе по типу медиа (картинки, видео; у музыки — прежние десять).
- **Два компьютера:** отчёт планов v5 (метки с областью, причины, `pickTarget`, активные выборы, `notChosen`, `handledPicks`, действия выбора с этого компьютера); владелец применяет чужие выборы на тике после чужих оценок, до этого считает их сделанными, а своё действие с выбором делает только после того, как применит ждущие чужие выборы (`weighPeerPicks`, с учётом ещё не применённых чужих отказов, как на тике); «ни один не подходит» с другого компьютера накрывает увиденные там попытки (`covered`) и уже решённые здесь, если они были в очереди владельца к моменту действия; отправивший показывает их сразу («отправлено»). Оба компьютера обновляются вместе.
- **Превью:** общий модуль `src/lib/media-preview/` (JPEG до 480 px через `sharp`, кэш в памяти); маршруты `…/preview` (свой и чужой план) — та же проверка файла, что у прослушивания.
- **Оператор (Factory API 1.13.0):** поля `reviewReasons`, `pickTarget`, `region`; в `factory_plan_get` — `picks`, `noneFits`, `notChosen`, `counts.picked/noneFits`, события `owner_pick` / `owner_unpick` / `owner_none_fits` / `peer_pick`; `group_reviewed` считает выборы.
- **Фаза 2 (§E–§F, только экран):** сравнение «Рядом · Шторка · Разница» с другой попыткой, с эталоном-картинкой или клипом (`references[]`) и «Было / Исправлено» у исправления; вопрос по клипу открывается на своей метке; «Как в ленте» (360/246/168/120 px); у петли (`metrics.loop: true`) — стык ±1 с, «подряд ×5», кадры стыка. Сервер, схема и отчёт не менялись.
- **Фаза 3 (§G):** файл плана может быть `From YTM/gemini/<jobId>/…` — выход Gemini без копирования (`resolveExchangeFile`, общий `workspace-exchange`; планы не импортируют модуль Gemini). Время оценки: экран считает секунды на попытку (вкладка видна, владелец активен) и шлёт `reviewSeconds` с вердиктом, ответом, выбором; хранится в истории вердиктов и событиях, приходит и с другого компьютера (v85: `review_seconds`).
- **Экран:** по типу файла — просмотр картинки (вписать / 100 %, сдвиг, Ctrl+колесо, размер) или видео (по кругу без звука, скорость, кадр, шкала с подсмотром, петля отрезка); лента вариантов пункта; слой во весь экран — сетка, лупа, сравнение двух; «Выбрать» (S), «Ни один не подходит»; метка-кружок Shift+перетаскиванием с заметкой. Музыкальный экран не менялся.

### 2.9ao Раскадровки до видео и вкладки Медиа по видам (BL-184, FO-REQ-0024, ADR 0038, `docs/roadmap/plans/STORYBOARD_PLAN.md`) — **IMPLEMENTED, влито в `dev` 2026-10-13 (`9b63975`); приёмка с раскадровкой «Бар» Оператора впереди**

- **Модуль `src/lib/storyboards/`** (AGENTS.md §M: зависит только от общих модулей; `boundaries.test.ts`).
  - Хранилище — семейство синхронизации `storyboards` (`sync-gateway/storyboards`, документ Automerge на канал; двенадцатое
    семейство): версии (целиком), отправки, решения, комментарии с ответами, выбор дублей, настройка запрета.
  - Состояние выводится: черновик → на проверке → нужны правки / одобрена; одобрена только последняя отправленная версия.
  - Кадры — файлы в `99 Data Exchange` канала (`Sent to YTM/...` или `From YTM/gemini|media/<jobId>/...`), sha256 заморожен в
    версии; «копия отличается / нет файла» на экране.
- **Запрет (этап 2, `storyboards/gate.ts`):** видео из двух разных первого и последнего кадров — только по одобренной раскадровке
  (`storyboard_not_approved`). Порт внедряется в `gemini-media` и `media-generation` в их `index.ts`; роли `first_frame` /
  `last_frame` у параметров-картинок шаблонов; связь задания с сегментом — столбцы `storyboard_id/storyboard_version/segment_id`
  в `media_jobs` и `gemini_media_jobs` (схема v90).
- **Factory API 1.16.0:** `factory_storyboard_create/update/get/list/submit/reply`; поля связи у `factory_media_create_job`,
  `factory_gemini_create_job`, элементов плана.
- **Web UI:** Медиа → «Музыка | Изображения | Раскадровка | Видео» (планы и журнал заданий — внутри вкладок видов, по виду
  шаблона и результатов; `/media/plans`, `/media/jobs` переадресуются); экран раскадровки (кадры, сегменты, таблица предметов,
  комментарии с булавками, версии, решения) и «Видео» (дубли сегментов, выбор, стыки, ролик целиком); значок «Медиа» и колокольчик.
- **Общий модуль `src/lib/local-file-response/`** — Range и потоковая отдача локального файла (прослушивание планов и дубли).
- **BL-189 (FO-REQ-0025, `docs/roadmap/plans/STORYBOARD_TAKES_PLAN.md`) — на ветке `feature/fo-req-0025-storyboard-takes`:**
  - Дубли со всех компьютеров: модуль-компоновщик `src/lib/storyboard-takes/` (свои задания + задания из отчётов `media-jobs`
    других компьютеров, BL-188); чужой дубль играет из своей копии папки канала или показывает «Сделан на …; файла пока нет».
  - Готовый ролик: `renders` / `renderDecisions` в документе раскадровки; `factory_storyboard_attach_render` (Factory API 1.18.0,
    только одобренная последняя версия, видео в папках обмена, выбранные дубли проверяются); владелец одобряет или просит
    изменения в «Ролик целиком» на любом компьютере.
  - Номер версии — отдельная метка после названия на карточках.

### 2.9aj Повторные проверки оценённых треков (BL-173, FO-REQ-0017, `docs/roadmap/plans/PLAN_RECHECKS_PLAN.md`) — **IMPLEMENTED, влито в `dev` (`77a915d`)**

- **Запись:** `generation_plan_rechecks` (v82, на компьютере плана) — исправленная версия (свой файл, проверки, метрики) или вопрос о месте; отдельно от `generation_plan_results`, строки и оценки оригинала не меняются. `recheck_id`/`kept` в `generation_plan_verdict_history` и `generation_plan_peer_verdicts`.
- **Ядро планов** (`src/lib/generation-plans/services.ts`): `requestRecheck` / `withdrawRecheck` (Factory API 1.11.0: `factory_plan_request_recheck` / `factory_plan_withdraw_recheck`), `answerRecheck` (Web `POST …/recheck`): оценка заменяет строку owner_review и пишется в историю с `recheckId`; «оставить оценку» (вопрос) — только заметка с `kept`, без `owner_verdict` и без счётчиков. Принятая исправленная версия — текущий файл попытки (`resolveAudition`, `progress.rechecks[].currentFile`). Счётчики `rechecksOpen`, `groups[].counts.rechecks` — не `waitingReview`. Перенос плана запрещён при открытой проверке, закрытие плана их отзывает.
- **Два компьютера:** отчёт планов v4 (`plans[].rechecks`, `currentFile`, `recheckId`/`kept`); ответ с другого компьютера — как оценка с `recheckId`, применяется один раз на тике владельца плана; до применения — «отвечено на …».
- **Экран:** Review → раздел «Повторные проверки» (`?wave=~rechecks`), A/B «Было / Исправлено», кнопки «к 0:25», «Оставить оценку» (K); карточка и список планов — «Повторные проверки: N».

### 2.9az Библиотека музыки по жанрам и оценка партий (BL-229, FO-REQ-0043, `docs/roadmap/plans/MUSIC_LIBRARY_PLAN.md`, ADR 0054 + поправка 1) — **IMPLEMENTED, влито в `dev` 2026-10-27; приёмка — партия music-014**

- **Модуль `src/lib/music-library/`** (§M, только чтение): снимок фабрики `<папка канала>/99 Data Exchange/Sent to YTM/music/library.json`
  через `workspace-exchange.resolveWorkspaceFile` (ссылка наружу — отказ), папка — того канала, что в запросе (`channel-workspaces`).
  Формат — `schemas.ts`, предложение фабрике (Q7/Q8): `format: 1`, `generatedAt`, `genres[]`, `batches[]`, `tracksWithoutGenre`;
  лишние поля игнорируются, ошибка в обязательном — весь файл «не прочитать». Чистая модель вида (`services.ts`): часы с одним
  знаком, доля принятых (нет процента при 0 проверенных), «устарело» старше 24 ч.
- **Web:** `GET /api/channels/[channelId]/music-library` (сессия + активный канал): `no_workspace` / `workspace_unavailable` /
  `no_file` / `unreadable` / `ok`. Медиа → «Музыка»: карточка «Библиотека по жанрам» над планами (`music-library-card.tsx`).
- Фабричные профили, CSV, журнал и длительности Manager не читает; ничего не пишет; MCP нет.
- **Часть B — оценка партии в обзоре плана** (новых экранов и файлов нет): у плана `reviewForm`, у волны `genre` (id, название,
  #rrggbb, эмодзи) и `reviewForm`; поля `yes_no` / `scale_1_10` / `choice`, лишние ключи внутри срезаются, id уникальны в форме плана
  плюс волны (`generation-plans/schemas.ts`, `review-forms.ts`). Вердикт: `answers`, коды `plan_answer_unknown_field` /
  `_wrong_type` / `_out_of_range` / `_unknown_option` / `_required`; хранятся в вердикте, истории и исходящих вердиктах (схема
  **v112** `answers_json`), видны в `owner_verdict`; отчёт планов **версии 6** — только когда в нём есть форма, жанр или ответы, иначе версия 5 (старая сборка читает его до
  первого такого плана); оценённая попытка открывается с сохранёнными ответами (и на плане другого компьютера); копия волны
  (`factory_plan_clone_group`) сохраняет жанр, вопросы и фишки; Factory API
  1.35.0, Agent API 4.9.0. Экран проверки: полоса жанра и цвет (`genre-review-model.ts`), две строки фишек для волны с жанром,
  вопросы под кнопками вердикта; значок жанра в списке планов.

### 2.9bd Речь голосами канала: Gemini TTS, реестр голосов, ElevenLabs (BL-236, FO-REQ-0050, `docs/roadmap/plans/SUMIRE_VOICE_PLAN.md`, ADR 0057) — **IMPLEMENTED на ветке `feature/bl-236-sumire-voice`, не влито; вызовы провайдеров проверены только на подделках**

- **Gemini:** вид задания `speech` (и запись платного дизайна `voice_design`) в `src/lib/gemini-media/` — та же таблица, ключ,
  переключатель, лимиты в USD, расход, воркер, папка; шлюз `gemini-api.ts`: `generateSpeech`, `designVoice`. Файл `take-1.wav` на
  родных 24 кГц (общий модуль `src/lib/shared-audio`: PCM → WAV), manifest kind `speech`; цена — счётчики Google, не ниже длины файла.
- **Реестр голосов** `src/lib/voice-registry/` (общий, §M; таблица `channel_voices`, схема v115): дизайн по описанию → превью-файлы
  в `From YTM/<provider>/voices/<voiceId>/` → владелец одобряет одно → голос говорит. Провайдеры — порты из `src/composition/speech.ts`;
  задания разрешают голос только через резолвер (`voice_not_approved`).
- **ElevenLabs** `src/lib/elevenlabs-speech/` (таблица `elevenlabs_speech_jobs`, слот секрета `elevenlabs`, воркер в
  `instrumentation.ts`), шлюз `media-gateway/elevenlabs-api.ts` (единственный путь к `api.elevenlabs.io`, категория `elevenlabs_api`);
  выключено по умолчанию, лимиты в символах; USD — оценка по прайсу. Без клонирования (`no-clone.test.ts`). Перезапуск по простою
  ждёт и задания ElevenLabs (`elevenlabs_job`). Один дубль: Gemini ≤ 2500 символов, ElevenLabs ≤ 5000 (укладывается в таймаут вызова).
  BL-250 (ADR 0057 поправка 1): месячный лимит ElevenLabs — лимит самого аккаунта (`GET /v1/user/subscription`), прочитанный и
  сохранённый на компьютере (`elevenlabs_account_snapshot`, привязан к отпечатку ключа); число владельца `maxCharsPerMonth` — запасное.
  Лимиты символов ElevenLabs общие для всех компьютеров (семья `elevenlabs_settings`, документ `ytm-elevenlabs-settings`, правила как у
  лимитов Gemini, конфликты — группа «Лимиты ElevenLabs»; `/api/elevenlabs-speech/settings-sync`, `.../resolve`), расход суммируется по
  компьютерам с тем же ключом (семья `elevenlabs_spend`, отчёт `ytm-elevenlabs-spend`, отпечаток `ytm/elevenlabs-key-fingerprint/v1`;
  цикл 30 с в `instrumentation.ts`). Переключатель и формат файла — свои у каждого компьютера.
- **MCP:** `factory_speech_*`, `factory_voice_*` (Factory API 1.40.0), `agent_speech_*`, `agent_voice_list` (Agent API 4.14.0).
- **Звуковые эффекты и музыка (BL-253, ADR 0057 поправка 2, `ELEVENLABS_SFX_MUSIC_PLAN.md`):** виды заданий `sfx` (`/v1/sound-generation`) и `music` (`/v1/music`, `music_v2_5`) в `elevenlabs-speech`; `factory_sfx_create_job` / `factory_music_create_job` (Factory API 1.45.0), результат через `factory_speech_get_job`; тот же выключатель и лимиты, в кредитах (эффект 40/с, музыка ≈900/мин); файлы `sfx-1.*` / `music-1.*`. Воркерам каналов не выдано. **Влито в `dev` (a74e6280), live 14.11.**
- **Web:** Настройки → Облачные API → ElevenLabs; Медиа → Музыка → «Голоса»; `/api/elevenlabs-speech*`, `/api/channels/[channelId]/voices*`.
- **Риски:** RISK-142, RISK-143, RISK-144.

### 2.9bg Клипы на проверку (BL-241, owner msgs 4010/4011, ADR 0061, `docs/roadmap/plans/CLIP_REVIEWS_PLAN.md`) — **IMPLEMENTED** (dev 1d03f9d1)

- **Модуль:** `src/lib/clip-reviews/` (§M: без других фич, Google и сети; файлы, канал и хранилище — порты). Клип — файл, уже лежащий в
  папке канала (путь относительно рабочей папки), проверенный общим `workspace-exchange.resolveWorkspaceFile` при отправке и при
  показе; `.mp4/.webm`, 5–300 с по `ffmpeg-host` (±0,5 с; без ffprobe — отказ), без ограничения размера; размер и SHA-256
  запоминаются. Не больше 50 ожидающих на канал, тот же файл дважды — `clip_review_duplicate`.
- **Хранение:** семейство синхронизации `clip_reviews` (документ Automerge на канал, `<данные приложения>/clip-reviews-doc`, подпапка
  Syncthing `clip-reviews`): клипы (не меняются после отправки) и решения. Статус выводится: первое решение владельца, иначе отзыв
  Продюсера. Схема БД не меняется.
- **Продюсер (Producer API 1.15.0; 1.19.0 — вложения, BL-246):** `producer_clip_review_submit` / `_withdraw` (DRAFT), `_list` / `_get` (READ), `producer-only`.
  Работники каналов и фабрика их не получают; одобрения и возврата нет ни в одном MCP-пути (`clip-reviews/boundaries.test.ts`).
- **Владелец:** маршруты `/api/channels/[channelId]/clip-reviews` (+ `/[clipId]/decision`, `/[clipId]/video` — HTTP Range, только
  loopback), сессия и активный канал, аудит решений (`clip:<clipId>`). Вкладка Медиа → «Клипы» (с 04.11, owner msg 4025; `/content/clips` ведёт туда; `src/components/clip-reviews-panel.tsx`,
  чистая часть `clip-reviews-model.ts`): компактные строки, плеер раскрывается в строке с отрезком `#t=start,end`; «Одобрить» (нужен
  тот самый файл на этом компьютере) и «Вернуть» (комментарий обязателен) с подтверждением в строке; значок ожидающих на вкладке (`clip-reviews-badge.ts`, своё чтение раз в минуту).
- **Вложения к ответу (BL-246, owner msgs 4076/4078/4079, ADR 0065) — IMPLEMENTED (merged dev d07af41f):**
  вставка картинки (⌘V), перетаскивание, «Прикрепить файл» (`src/components/clip-attachments.tsx`); до 10 файлов по 50 МиБ,
  png/jpg/webp/gif/pdf/txt/md/json/mp4/webm/mov — по расширению, заявленному типу и первым байтам (`clip-reviews/attachments.ts`).
  Файл идёт частями по 4 МиБ (`/[clipId]/uploads`, `/uploads/[uploadId]`; прокси обрезает тело больше 40 МБ) во временную
  папку `<данные приложения>/clip-review-uploads` (чистится через 24 ч); решение пишет файлы всё-или-ничего в
  `<папка канала>/99 Data Exchange/From YTM/clip-reviews/<clipId>/<decisionId>/` (общие `workspace-exchange.resolveFromYtmFolder` /
  `resolveFromYtmFolderFile`) и хранит `attachments` в решении. Показ — `/[clipId]/attachments/[decisionId]/[index]`, только loopback;
  нет файла — «ещё не пришёл», другой — «изменён». Producer API 1.19.0: `attachments` в `_get` / `_list`.
- **Версии сцены (BL-247, owner msgs 4085/4087, план п. 18–20) — IMPLEMENTED (merged dev 5010a7a9):** экран группирует
  клипы по `sceneId` (чистая `scenesOf` в `clip-reviews-model.ts`): строка = сцена, последняя версия `v<n>`, внутри предыдущие
  (на ожидающую можно ответить); сначала ждущие сцены, новые сверху. `waiting` владельца и значок считают сцены. Хранилище,
  инструменты Продюсера и их порядок не менялись.

### 2.9bo Кадры на проверку — мастер-кадры сцен (BL-272, owner TG 2547 через Продюсера, ADR 0076) — **IMPLEMENTED на ветке `feature/image-reviews`, не влито**

- **Модуль:** `src/lib/image-reviews/` (§M: без других фич, клипов в том числе, без Google и сети; файлы, канал и хранилище — порты).
  Кадр — PNG/JPEG, уже лежащий в папке канала; путь проверяется общим правилом (`review-items.resolveReviewFile` поверх
  `workspace-exchange`) при отправке и при показе — реальный путь строго внутри папки этого канала; папку другого канала нельзя
  задать внутри или вокруг неё (`channel-workspaces`, `CHANNEL_WORKSPACE_NESTED`), так что файл другого канала всегда снаружи. Формат по заголовку (`sharp`), 16–16384 px,
  до 50 МиБ; размер и SHA-256 запоминаются. `requestId` — повтор отправки возвращает тот же кадр (`replayed: true`), тот же id с другим
  запросом — отказ; `batchId` — партия (до 40), не больше 200 ожидающих на канал.
- **Общий модуль `src/lib/review-items/`:** правило «первое решение владельца, иначе отзыв», единственное правило статуса кадра
  (`imageReviewStateOf` — им пользуются и кадры, и порт исходного кадра клипов `createClipSourceImageLookup`) и файловый адаптер (путь, кэш SHA-256 —
  LRU на 500 файлов, вытесняется давно не читанный) вынесены из клипов; клипы и кадры друг друга не импортируют (`image-reviews/boundaries.test.ts`).
- **Хранение:** семейство синхронизации `image_reviews` (документ Automerge на канал, `<данные приложения>/image-reviews-doc`,
  подпапка Syncthing `image-reviews`): кадры и решения. Статус выводится. Схема БД не меняется.
- **Продюсер (Producer API 1.28.0):** `producer_image_review_submit` / `_withdraw` (DRAFT), `_list` / `_get` (READ), `producer-only`.
  `producer_clip_review_submit` принимает `approvedImageId` — одобренный кадр того же канала (иначе `clip_review_image_not_found` /
  `_not_approved`); клип хранит его, владелец видит кадр рядом с клипом.
- **Владелец:** маршруты `/api/channels/[channelId]/image-reviews` (+ `/[imageId]/decision`, `/image`, `/preview` — превью JPEG до
  960 px общим `media-preview`; файлы только браузеру владельца), аудит `image:<imageId>`. Список проверяет копию на этом компьютере
  (путь + SHA-256) только у ожидающих кадров (одобрить можно только их), у отвеченных `file: null`; значок вкладки читает
  `?view=count` — только `{ waiting }` из документа, без работы с файлами. Вкладка Медиа → «Кадры» перед «Клипами»
  (`image-reviews-panel.tsx`, чистая часть `image-reviews-model.ts`, значок `image-reviews-badge.ts`): партия — сетка больших превью,
  просмотр во весь размер (← / →, «Вписать / 100 %», Esc), на каждый кадр «Одобрить», «С заметкой» (заметка обязательна) или «Вернуть»
  (комментарий обязателен) с подтверждением в карточке; отвеченные партии свёрнуты.
- **Будит Продюсера:** каждое решение — `REVIEW-DECISION-image-<imageId>-<decisionId>.md` (review-notify, вид `image`, ADR 0066).
  Если более ранний возврат с другого компьютера пришёл после одобрения — ещё файл `…-<approvalId>-overturned-by-<returnId>.md`
  (статус `approval_overturned`): одобрение больше не действует. Карточка клипа показывает текущий статус исходного кадра и
  подсвечивает всё, кроме двух одобрений; «кадра нет» значит «на этом компьютере его пока нет».
- **Не сделано:** варианты обложек (`kind: thumbnail`), вложения к ответу по кадру.
