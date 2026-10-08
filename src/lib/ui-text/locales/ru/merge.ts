import type { merge as en } from "../en/merge";

export const merge: Record<keyof typeof en, string> = {
  "handoff.family.changeDrafts": "Черновики изменений",
  "handoff.family.editorialProfiles": "Редакционные профили",
  "handoff.family.aiConnections": "Подключения к ИИ",
  "handoff.family.mediaSessions": "Сессии RunPod",
  "handoff.family.generationPlans": "Планы генерации",
  "handoff.family.mediaSettings": "Настройки серверов",

  "handoff.requestFailed": "Запрос к {url} не выполнен ({status})",
  "handoff.justNow": "только что",
  "handoff.minutesAgo": "{count, plural, one {# минуту назад} few {# минуты назад} many {# минут назад} other {# минуты назад}}",
  "handoff.hoursAgo": "{count, plural, one {# час назад} few {# часа назад} many {# часов назад} other {# часа назад}}",
  "handoff.daysAgo": "{count, plural, one {# день назад} few {# дня назад} many {# дней назад} other {# дня назад}}",

  "handoff.error.loadStatus": "Не удалось загрузить состояние",
  "handoff.error.listSnapshots": "Не удалось получить список снимков",
  "handoff.error.loadSyncStatus": "Не удалось загрузить состояние синхронизации",
  "handoff.error.loadConflicts": "Не удалось загрузить конфликты",
  "handoff.error.loadAiConflicts": "Не удалось загрузить конфликты подключений к ИИ",
  "handoff.error.syncFailed": "Синхронизация не удалась",
  "handoff.error.adoptFailed": "Не удалось принять версию другого компьютера",
  "handoff.error.exportFailed": "Экспорт не удался",
  "handoff.error.importFailed": "Импорт не удался",
  "handoff.error.acknowledgeFailed": "Не удалось записать подтверждение",

  "handoff.subject.change": "изменение {id}",
  "handoff.subject.editorialProfile": "редакционный профиль",
  "handoff.subject.connection": "подключение {id}",

  "handoff.summary.changeDrafts":
    "Черновики изменений: отправлено {pushed} из {total, plural, one {# канала} few {# каналов} many {# каналов} other {# канала}}, объединено с {peers, plural, one {# другим компьютером} few {# другими компьютерами} many {# другими компьютерами} other {# другого компьютера}}, {conflicts, plural, one {# новый конфликт} few {# новых конфликта} many {# новых конфликтов} other {# нового конфликта}}.",
  "handoff.summary.changeDraftsFailed": "Черновики изменений: ошибка ({error}).",
  "handoff.summary.profiles":
    "Редакционные профили: отправлено {pushed}, {conflicts, plural, one {# новый конфликт} few {# новых конфликта} many {# новых конфликтов} other {# нового конфликта}}.",
  "handoff.summary.profilesFailed": "Редакционные профили: ошибка ({error}).",
  "handoff.summary.connectionsPushed":
    "Подключения к ИИ: отправлены, {conflicts, plural, one {# новый конфликт} few {# новых конфликта} many {# новых конфликтов} other {# нового конфликта}}.",
  "handoff.summary.connectionsNothing":
    "Подключения к ИИ: отправлять нечего, {conflicts, plural, one {# новый конфликт} few {# новых конфликта} many {# новых конфликтов} other {# нового конфликта}}.",
  "handoff.summary.connectionsFailed": "Подключения к ИИ: ошибка ({error}).",

  "handoff.adopted": "Принята версия компьютера {device}. Прежняя локальная копия сохранена в {path}.",
  "handoff.adoptedNoBackup": "Принята версия компьютера {device} (локальной копии для резервирования не было).",
  "handoff.exported":
    "Экспортировано как снимок {snapshot} (поколение {generation}). Это лишь фиксирует, что экспорт на этом компьютере завершён, — но не подтверждает, что другой компьютер прекратил работу.",
  "handoff.imported.recovery":
    "Импортировано, но на этом компьютере остались незавершённые операции с YouTube — включён ограниченный режим восстановления. Подробности ниже.",
  "handoff.imported.duplicate": "Этот снимок уже является текущим состоянием этого компьютера — ничего не изменилось.",
  "handoff.imported.ok": "Импортировано и включено в обычном режиме.",

  "handoff.recovery.title": "Ограниченный режим восстановления",
  "handoff.recovery.body":
    "На этом компьютере {count, plural, one {есть # строка выполнения пакета} few {есть # строки выполнения пакетов} many {есть # строк выполнения пакетов} other {есть # строки выполнения пакетов}} с неясным результатом записи в YouTube (импортировано из снимка). Любые изменяющие действия — и локальные, и запись в YouTube — запрещены, пока это не будет решено через штатный механизм восстановления. Подтверждение ниже лишь фиксирует, что вы это просмотрели; оно не меняет статус строк и не снимает ограничение.",
  "handoff.recovery.row": "пакет {batch} / видео {video}: {status}",
  "handoff.recovery.recording": "Запись…",
  "handoff.recovery.acknowledge": "Просмотрено (только подтвердить)",

  "handoff.syncStatus.title": "Состояние синхронизации",
  "handoff.syncStatus.intro":
    "Наборы изменений, редакционные профили и подключения к ИИ постоянно синхронизируются в фоне между компьютерами с общей папкой Syncthing (Настройки → Синхронизация; проверка каждую минуту, пока приложение открыто) — кнопка выше просто запускает все три цикла сразу. Конфликт ниже означает, что два компьютера изменили одно и то же поле без связи; ничего не выбирается автоматически — когда конфликт появится, выберите, какую версию оставить.",
  "handoff.syncStatus.failed": "Ошибка",
  "handoff.syncStatus.never": "Ещё не синхронизировалось",
  "handoff.syncStatus.ok": "ОК",
  "handoff.syncStatus.conflicts": "{count, plural, one {# конфликт} few {# конфликта} many {# конфликтов} other {# конфликта}}",

  "handoff.pushErrors.title":
    "Папка синхронизации недоступна для {count, plural, one {# элемента} few {# элементов} many {# элементов} other {# элемента}}",
  "handoff.pushErrors.hint":
    "Локально ничего не потеряно — просто изменения этого компьютера не были опубликованы в этом цикле. Проверьте, что папка Syncthing (Настройки → Синхронизация) действительно подключена и доступна.",
  "handoff.peersSkipped.title":
    "{count, plural, one {# файл другого компьютера не удалось} few {# файла других компьютеров не удалось} many {# файлов других компьютеров не удалось} other {# файла других компьютеров не удалось}} объединить в этом цикле",
  "handoff.peersSkipped.row": "{family}{channel}, компьютер {device}: {reason}",
  "handoff.peersSkipped.adopt": "Отбросить мою локальную копию и принять версию того компьютера",
  "handoff.peersSkipped.switchChannel": "Переключитесь на этот канал, чтобы решить это здесь.",
  "handoff.peersSkipped.hint":
    "Это не то же самое, что конфликт на уровне поля (ниже): у этого и того компьютера вообще нет общей истории, и их данные нельзя объединить автоматически (например, повреждён файл или данные на двух компьютерах начинались независимо). Здесь можно решить только записи «расходящаяся история» — явно отбросив одну из сторон; при любой другой причине (например, повреждённый файл) попытки продолжатся автоматически.",

  "handoff.adoptConfirm.title": "Отбросить локальную копию и принять версию другого компьютера?",
  "handoff.adoptConfirm.body":
    "Локальные данные «{family}» этого компьютера будут навсегда заменены версией компьютера {device}. Текущая локальная копия сначала сохраняется в файл (и никогда не удаляется), но само это действие на этом экране отменить нельзя.",
  "handoff.adoptConfirm.adopting": "Принимаем…",
  "handoff.adoptConfirm.confirm": "Отбросить и принять",

  "handoff.title": "Передача работы между компьютерами",
  "handoff.intro":
    "Отдельный механизм, не связанный с постоянной синхронизацией выше: явная передача права на запись в YouTube (пакеты, журнал их выполнения и журнал аудита) с одного компьютера на другой: в каждый момент им владеет только один компьютер, а непрерывно в фоне это синхронизировать нельзя.",
  "handoff.export.title": "Закончить работу на этом компьютере",
  "handoff.export.body":
    "Экспортирует очищенный снимок (без токенов OAuth и ключей подключений к ИИ) в папку Syncthing (Настройки → Синхронизация). Это фиксирует, что экспорт здесь завершён, — но не может подтвердить, что другой компьютер прекратил работу.",
  "handoff.export.busy": "Экспорт…",
  "handoff.export.button": "Экспортировать",
  "handoff.import.title": "Продолжить работу на этом компьютере",
  "handoff.import.body":
    "Доступные снимки в папке синхронизации. Импорт никогда не продолжает незавершённую или неясную запись в YouTube автоматически.",
  "handoff.import.none": "Снимков не найдено.",
  "handoff.import.snapshot": "{snapshot} (компьютер {device}, поколение {generation}, {time})",
  "handoff.import.busy": "Импорт…",
  "handoff.import.button": "Импортировать",

  "divergence.title": "Данные на двух компьютерах различаются",
  "divergence.intro":
    "Это синхронизация снимками для пакетов, журнала аудита, исследований и решений — целые копии с одной историей. С момента последнего согласия оба компьютера изменили эти данные, поэтому нужно выбрать одну версию. Наборы изменений, профили и подключения к ИИ это не затрагивает (их конфликты перечислены ниже).",
  "divergence.thisComputer": "Этот компьютер",
  "divergence.otherComputer": "Другой компьютер",
  "divergence.device": "компьютер {id}",
  "divergence.unknownDevice": "неизвестен",
  "divergence.unknownTime": "время неизвестно",
  "divergence.lastPublished": "последняя публикация {time}",
  "divergence.published": "опубликовано {time}",
  "divergence.unpublished": "Есть неопубликованные изменения.",
  "divergence.commonBase": "Обе версии продолжают версию от {time}; всё ниже изменилось после неё.",
  "divergence.comparing": "Сравниваем две версии…",
  "divergence.compareFailed": "Не удалось сравнить две версии: {error}",
  "divergence.nowSame": "Теперь в обеих версиях одинаковые данные; это решится само при следующей синхронизации.",
  "divergence.manyTips":
    "В конфликте {count, plural, one {# другая версия} few {# другие версии} many {# других версий} other {# другой версии}}; сравнение идёт только с самой новой. «Оставить данные этого компьютера» заменяет их все.",
  "divergence.column.section": "Раздел",
  "divergence.column.onlyHere": "Только на этом компьютере",
  "divergence.column.onlyThere": "Только на другом",
  "divergence.column.changed": "На обоих, но различаются",
  "divergence.section.batches": "Пакеты",
  "divergence.section.audit": "Аудит",
  "divergence.section.research": "Исследования",
  "divergence.section.decisions": "Решения",
  "divergence.section.other": "Прочее",
  "divergence.sectionHint.batches": "подготовленные и выполненные пакеты и их строки по видео",
  "divergence.sectionHint.audit": "журнал записей в YouTube",
  "divergence.sectionHint.research": "Сбор рыночных данных: каналы для исследования и собранные по ним снимки",
  "divergence.sectionHint.decisions": "гипотезы и эксперименты",
  "divergence.sectionHint.other": "прочие переносимые данные",
  "divergence.tableCounts": "{table}: +{here} здесь / +{there} там / {changed} изменено",
  "divergence.rows": "{count, plural, one {# строка} few {# строки} many {# строк} other {# строки}}",
  "divergence.identical": "Совпадает на обоих компьютерах: {sections}.",
  "divergence.keepMine": "Оставить данные этого компьютера",
  "divergence.keepMineHint": "Другой компьютер перейдёт на эту версию.",
  "divergence.keepMineHintLoses":
    "Другой компьютер перейдёт на эту версию и потеряет {count, plural, one {# строку} few {# строки} many {# строк} other {# строки}} (они останутся там в резервной копии).",
  "divergence.takeTheirs": "Взять данные другого компьютера",
  "divergence.takeTheirsHint": "Этот компьютер перейдёт на другую версию.",
  "divergence.takeTheirsHintLoses":
    "Этот компьютер перейдёт на другую версию и потеряет {count, plural, one {# строку} few {# строки} many {# строк} other {# строки}} (сначала сохраняется резервная копия).",
  "divergence.confirmKeep.title": "Оставить данные этого компьютера?",
  "divergence.confirmKeep.body":
    "Пакеты, журнал аудита, исследования и решения этого компьютера заменят данные другого компьютера при его следующей синхронизации.",
  "divergence.confirmKeep.bodyLoses":
    "Пакеты, журнал аудита, исследования и решения этого компьютера заменят данные другого компьютера при его следующей синхронизации. Другой компьютер потеряет {count, plural, one {# строку} few {# строки} many {# строк} other {# строки}}, указанные выше; они останутся там в резервной копии.",
  "divergence.confirmKeep.confirm": "Оставить мои",
  "divergence.confirmTake.title": "Взять данные другого компьютера?",
  "divergence.confirmTake.body":
    "Пакеты, журнал аудита, исследования и решения этого компьютера будут заменены данными другого компьютера. Сначала сохраняется резервная копия текущих данных этого компьютера.",
  "divergence.confirmTake.bodyLoses":
    "Пакеты, журнал аудита, исследования и решения этого компьютера будут заменены данными другого компьютера. Этот компьютер потеряет {count, plural, one {# строку} few {# строки} many {# строк} other {# строки}}, указанные выше. Сначала сохраняется резервная копия текущих данных этого компьютера.",
  "divergence.confirmTake.confirm": "Взять их",
};
