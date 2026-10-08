// BL-152: the Russian interface text. Translated by meaning, not word for word (owner, msg 2032, Q3). Each area is typed
// against its English area, so a missing or extra key fails the build.
//
// Glossary -- one translation per term, everywhere:
//   Batch → пакет · Change Set → набор изменений · Live writes → запись в YouTube · Merge (tab) → Слияние ·
//   Production → Производство · Research → Исследования · Decisions → Решения · Reach → охват ·
//   Session → сессия · Job → задание · Workflow template → шаблон процесса · Device sync → синхронизация компьютеров ·
//   AI Localization → ИИ-перевод · Watchlist → список наблюдения · Change drafts → черновики изменений ·
//   Privacy (YouTube's own words) → Открытый доступ / Доступ по ссылке / Ограниченный доступ; private (in running text) → «ограниченный доступ» (e.g. «видео с ограниченным доступом») ·
//   Default language → язык по умолчанию · AI connections → Подключения к ИИ · Market intelligence → сбор рыночных данных ·
//   Device → компьютер · Dashboard (opening the app) → приложение («при открытии приложения») · Issue a token → выдать ·
//   Settings (the section, in running text) → «в Настройках»; tab names in quotes are never declined («на вкладке «Сессии»»). Product and service names stay as they are: YouTube, Google Cloud, MCP, CLI, API,
//   RunPod, Syncthing, Factory Operator, Operations Manager.
import type { UiTextKey } from "./en";
import { analytics } from "./ru/analytics";
import { analyticsLabels } from "./ru/analyticsLabels";
import { batches } from "./ru/batches";
import { common } from "./ru/common";
import { content } from "./ru/content";
import { decisions } from "./ru/decisions";
import { errors } from "./ru/errors";
import { languages } from "./ru/languages";
import { media } from "./ru/media";
import { merge } from "./ru/merge";
import { production } from "./ru/production";
import { research } from "./ru/research";
import { researchData } from "./ru/researchData";
import { settings } from "./ru/settings";
import { settingsCards } from "./ru/settingsCards";
import { shell } from "./ru/shell";

export const ruAreas = { common, shell, settings, production, media, languages, batches, decisions, research, researchData, analytics, content, merge, settingsCards, errors, analyticsLabels } as const;

export const ru: Record<UiTextKey, string> = { ...common, ...shell, ...settings, ...production, ...media, ...languages, ...batches, ...decisions, ...research, ...researchData, ...analytics, ...content, ...merge, ...settingsCards, ...errors, ...analyticsLabels };
