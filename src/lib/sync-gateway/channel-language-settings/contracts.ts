import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-178 part B (docs/roadmap/plans/LOCALIZATION_BASELINE_PLAN.md §3.2; FO-REQ-0022; owner В3 "да", Telegram msg 2665): a
// channel's language settings -- the baseline (Languages -> Language defaults) and the tracked languages -- the same on every
// computer. One Automerge document per channel. Before this family each computer kept its own copy in `channels`
// (`expected_default_language`, `expected_default_audio_language`, `target_languages_json`), so a baseline set on Windows never
// reached the Mac and every Batch from the Mac failed.

export const LANGUAGE_SETTING_FIELDS = ["defaultLanguage", "defaultAudioLanguage", "trackedLanguages"] as const;
export type LanguageSettingField = (typeof LANGUAGE_SETTING_FIELDS)[number];

/** The fields a Batch writes with (PROJECT_SPEC §14): while one of them differs between the computers, Batches refuse. */
export const BASELINE_FIELDS: readonly LanguageSettingField[] = ["defaultLanguage", "defaultAudioLanguage"];

export type LanguageSettingValues = {
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  trackedLanguages: string[];
};

export type LanguageSettingValue = LanguageSettingValues[LanguageSettingField];

export type ChannelLanguageSettingsDocument = {
  format: "ytm-channel-language-settings";
  version: 1;
  channelId: string;
  /** A field is absent until a computer saves it or seeds it from its own earlier value. */
  settings: Partial<LanguageSettingValues>;
};

/**
 * A field set to DIFFERENT values on two computers before they met. The same value written on both is not a conflict
 * (Automerge records both writes; they are deduplicated here). Tracked languages compare as a set: the same languages in
 * another order are the same setting. `valuesByActor` keeps one writer per distinct value, which is what a choice names.
 */
export type LanguageSettingConflict = {
  field: LanguageSettingField;
  values: LanguageSettingValue[];
  valuesByActor: Record<string, LanguageSettingValue>;
  /** This computer's own value, kept until the owner chooses. */
  thisComputer: LanguageSettingValue;
};

export type MergeResult = { newConflicts: LanguageSettingConflict[] };
