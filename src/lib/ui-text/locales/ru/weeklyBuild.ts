import type { weeklyBuild as en } from "../en/weeklyBuild";

// BL-231 (FO-REQ-0046): Контент → «План недели» → сборка недели. BL-267: тексты старой карточки ушли вместе с ней.
export const weeklyBuild: Record<keyof typeof en, string> = {
  "weeklyBuild.title": "Сборка недели",
};
