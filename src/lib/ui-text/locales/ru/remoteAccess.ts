import type { remoteAccess as en } from "../en/remoteAccess";

// BL-251: доступ с других устройств владельца через Tailscale.
export const remoteAccess: Record<keyof typeof en, string> = {
  "remoteAccess.title": "Доступ с других устройств",
  "remoteAccess.info": "Открывать YT Manager с телефона или другого компьютера через вашу личную сеть Tailscale, по паролю. YT Manager по-прежнему слушает только этот Mac; Tailscale пропускает ваши устройства. Агенты (MCP) работают только на этом Mac.",
  "remoteAccess.switch": "Разрешить доступ с моих других устройств",
  "remoteAccess.turnedOn": "Доступ с других устройств включён.",
  "remoteAccess.turnedOff": "Доступ с других устройств выключен; телефоны вышли из YT Manager.",
  "remoteAccess.passwordSet": "Пароль задан.",
  "remoteAccess.passwordNotSet": "Пароля пока нет: задайте его, чтобы включить доступ.",
  "remoteAccess.passwordLabel": "Новый пароль (не меньше 8 символов)",
  "remoteAccess.passwordSave": "Сохранить пароль",
  "remoteAccess.passwordSaved": "Пароль сохранён; телефонам, вошедшим раньше, нужно войти заново.",
  "remoteAccess.passwordTooShort": "Не меньше 8 символов.",
  "remoteAccess.ownerLogin": "Доверенный аккаунт Tailscale: {login}",
  "remoteAccess.locked": "Слишком много неверных паролей: вход с других устройств приостановлен до {until}.",
  "remoteAccess.macOnly": "Эти настройки меняются только на самом Mac.",
  "remoteAccess.steps": "На Mac: поставьте Tailscale и войдите тем же аккаунтом, что на телефоне. Затем откройте на телефоне https://<имя этого Mac>.<ваша сеть>.ts.net.",
  "remoteAccess.login.title": "Вход с другого устройства",
  "remoteAccess.login.password": "Пароль",
  "remoteAccess.login.submit": "Войти",
  "remoteAccess.login.wrong": "Неверный пароль.",
  "remoteAccess.login.locked": "Слишком много неверных паролей. Попробуйте через 15 минут.",
  "remoteAccess.login.disabled": "Доступ с других устройств выключен на Mac.",
  "remoteAccess.login.noChannel": "На Mac нет подключённого канала, под которым можно войти.",
  "remoteAccess.login.failed": "Не удалось войти.",
  "remoteAccess.onMacOnly": "Подключение аккаунтов Google работает только на самом Mac.",
};
