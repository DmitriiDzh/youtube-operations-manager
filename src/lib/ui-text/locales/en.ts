// BL-152: the English interface text -- the source every other locale translates. One file per area of the app, so
// separate work on separate areas never edits the same file; keys are prefixed by area and must be unique overall.
import { analytics } from "./en/analytics";
import { analyticsLabels } from "./en/analyticsLabels";
import { batches } from "./en/batches";
import { common } from "./en/common";
import { content } from "./en/content";
import { decisions } from "./en/decisions";
import { errors } from "./en/errors";
import { languages } from "./en/languages";
import { media } from "./en/media";
import { merge } from "./en/merge";
import { production } from "./en/production";
import { research } from "./en/research";
import { researchData } from "./en/researchData";
import { settings } from "./en/settings";
import { settingsCards } from "./en/settingsCards";
import { shell } from "./en/shell";

export const enAreas = { common, shell, settings, production, media, languages, batches, decisions, research, researchData, analytics, content, merge, settingsCards, errors, analyticsLabels } as const;

export const en = { ...common, ...shell, ...settings, ...production, ...media, ...languages, ...batches, ...decisions, ...research, ...researchData, ...analytics, ...content, ...merge, ...settingsCards, ...errors, ...analyticsLabels } as const;

export type UiTextKey = keyof typeof en;
