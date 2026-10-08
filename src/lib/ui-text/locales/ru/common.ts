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

  "errorBoundary.title": "Сбой в разделе «{label}».",
  "errorBoundary.body": "Остальное приложение работает. Попробуйте ещё раз или перейдите на другую вкладку.",
};
