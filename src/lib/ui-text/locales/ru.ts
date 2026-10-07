// BL-152: the Russian interface text. Translated by meaning, not word for word (owner, msg 2032, Q3). Each area is typed
// against its English area, so a missing or extra key fails the build.
//
// Glossary -- one translation per term, everywhere:
//   Batch → пакет · Change Set → набор изменений · Live writes → запись в YouTube · Merge (tab) → Слияние ·
//   Production → Производство · Research → Исследования · Decisions → Решения · Reach → охват ·
//   Session → сессия · Job → задание · Workflow template → шаблон процесса · Device sync → синхронизация компьютеров ·
//   AI Localization → ИИ-перевод. Product and service names stay as they are: YouTube, Google Cloud, MCP, CLI, API,
//   RunPod, Syncthing, Factory Operator, Operations Manager.
import type { UiTextKey } from "./en";
import { common } from "./ru/common";
import { production } from "./ru/production";
import { settings } from "./ru/settings";
import { shell } from "./ru/shell";

export const ruAreas = { common, shell, settings, production } as const;

export const ru: Record<UiTextKey, string> = { ...common, ...shell, ...settings, ...production };
