import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-150 (owner, Telegram 2026-10-07, msg 2008; docs/roadmap/plans/PRODUCTION_SETTINGS_SYNC_PLAN.md): the Production → Setup
// settings, the same on every device. One global Automerge document holding an OPAQUE map of setting values: which fields
// are shared, and how a received value is applied, is media-generation's business (it validates and applies through its own
// rules); this family only carries the values and reports conflicts. It imports nothing from media-generation (§M).

export const GLOBAL_DOCUMENT_KEY = "global";

/** A JSON value as stored in the document (a setting is a string, number, boolean, null or an array of strings). */
export type SettingValue = string | number | boolean | null | string[];

export type MediaSettingsDocument = {
  format: "ytm-media-settings";
  version: 1;
  settings: Record<string, SettingValue>;
};

/**
 * A field set to DIFFERENT values on two devices before they met. Two devices that wrote the same value are not a conflict
 * (Automerge still records both writes; they are deduplicated here), so two devices with identical settings never show one.
 */
export type SettingConflict = { field: string; values: SettingValue[]; valuesByActor: Record<string, unknown> };

export type MergeResult = { newConflicts: SettingConflict[] };
