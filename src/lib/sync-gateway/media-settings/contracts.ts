import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-150 (owner, Telegram 2026-10-07, msg 2008; docs/roadmap/plans/PRODUCTION_SETTINGS_SYNC_PLAN.md): the Servers → Setup
// settings, the same on every device. One global Automerge document holding an OPAQUE map of setting values: which fields
// are shared, and how a received value is applied, is media-generation's business (it validates and applies through its own
// rules); this family only carries the values and reports conflicts. It imports nothing from media-generation (§M).

export const GLOBAL_DOCUMENT_KEY = "global";

/** A JSON value as stored in the document (a setting is a string, number, boolean, null or an array of strings). */
export type SettingValue = string | number | boolean | null | string[];

export type MediaSettingsDocument = {
  /** "ytm-media-settings"; BL-193: "ytm-gemini-settings" for the Gemini limits' own document (the same opaque-map engine). */
  format: string;
  version: 1;
  settings: Record<string, SettingValue>;
};

/**
 * BL-193 (ADR 0039): which settings-map document a core works on. Each family has its own format and its own fixed genesis actor,
 * so its genesis change is the same on every device (and never the same as another family's).
 */
export type SettingsMapKind = { format: string; genesisActor: string };
export const MEDIA_SETTINGS_KIND: SettingsMapKind = Object.freeze({ format: "ytm-media-settings", genesisActor: "6d656469612d73657474696e67733031" }); // hex of "media-settings01"
export const GEMINI_SETTINGS_KIND: SettingsMapKind = Object.freeze({ format: "ytm-gemini-settings", genesisActor: "67656d696e692d73657474696e677331" }); // hex of "gemini-settings1"
/** BL-236 (owner msg 3823): the ElevenLabs character limits' own document, the same engine. */
export const ELEVENLABS_SETTINGS_KIND: SettingsMapKind = Object.freeze({ format: "ytm-elevenlabs-settings", genesisActor: "656c6576656e6c6162732d7365747331" }); // hex of "elevenlabs-sets1"

/**
 * A field set to DIFFERENT values on two devices before they met. Two devices that wrote the same value are not a conflict
 * (Automerge still records both writes; they are deduplicated here), so two devices with identical settings never show one.
 */
export type SettingConflict = { field: string; values: SettingValue[]; valuesByActor: Record<string, unknown> };

export type MergeResult = { newConflicts: SettingConflict[] };
