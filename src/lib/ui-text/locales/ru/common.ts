import type { common as en } from "../en/common";

export const common: Record<keyof typeof en, string> = {
  "app.description": "Управление YouTube-каналами: контент, переводы, аналитика и исследования",
  "signIn.google": "Войти через Google",

  "common.loading": "Загрузка…",
  "common.cancel": "Отмена",
  "common.close": "Закрыть",
  "common.save": "Сохранить",
  "common.saving": "Сохранение…",
  "common.saved": "Сохранено.",
  "common.retry": "Повторить",
  "common.tryAgain": "Попробовать снова",
  "common.later": "Позже",
  "common.never": "никогда",
  "common.stopping": "Остановка…",
  "common.success": "Готово",
  "common.syncNow": "Синхронизировать",
  "common.syncing": "Синхронизация…",
  "common.syncRecent.title": "Канал недавно синхронизирован",
  "common.syncRecent.description":
    "{minutes, plural, =0 {Последняя синхронизация была меньше минуты назад.} one {Последняя синхронизация была # минуту назад.} few {Последняя синхронизация была # минуты назад.} many {Последняя синхронизация была # минут назад.} other {Последняя синхронизация была # минуты назад.}} Синхронизировать снова?",
  "common.syncRecent.confirm": "Синхронизировать снова",
  "common.moreInfo": "Подробнее",
  "common.errorStatus": "Ошибка {status}",
  "common.errorDetail": "{text} Подробности: {detail}",

  "value.notSet": "не задано",
  "value.on": "Вкл.",
  "value.off": "Выкл.",
  "value.none": "нет",

  "unit.usd": "${value}",
  "unit.usdPerHour": "${value}/ч",
  "unit.minutes": "{value} мин",
  "unit.seconds": "{value} с",
  "unit.gb": "{value} ГБ",

  "duration.seconds": "{s} с",
  "duration.minutesSeconds": "{m} мин {s} с",
  "duration.hoursMinutes": "{h} ч {m} мин",

  "format.timePlaceholder": "ЧЧ:ММ",
  "utcTime.utc": "UTC",
  "utcTime.localHint": "({time} по вашему времени)",
  "utcTime.localHintNextDay": "({time} следующего дня по вашему времени)",
  "utcTime.localHintPreviousDay": "({time} предыдущего дня по вашему времени)",
  "utcTime.localHintTitle": "Ваш часовой пояс: {zone}. Летнее и зимнее время учтены для даты {date}.",

  "errorBoundary.title": "Сбой в разделе «{label}».",
  "errorBoundary.body": "Остальное приложение работает. Попробуйте ещё раз или перейдите на другую вкладку.",

  "timeUntil.now": "сейчас",
  "timeUntil.lessThanMinute": "меньше минуты",
  "timeUntil.hoursMinutes": "{h} ч {m} мин",
  "timeUntil.minutes": "{m} мин",
};
