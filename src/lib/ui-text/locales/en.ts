// BL-152: the English interface text -- the source every other locale translates. One file per area of the app, so
// separate work on separate areas never edits the same file; keys are prefixed by area and must be unique overall.
import { common } from "./en/common";
import { production } from "./en/production";
import { settings } from "./en/settings";
import { shell } from "./en/shell";

export const enAreas = { common, shell, settings, production } as const;

export const en = { ...common, ...shell, ...settings, ...production } as const;

export type UiTextKey = keyof typeof en;
