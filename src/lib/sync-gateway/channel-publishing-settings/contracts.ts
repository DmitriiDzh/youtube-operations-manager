import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-182 stage 2 (docs/roadmap/plans/PUBLISHING_PLAN.md §2 stage 2 item 2; FO-REQ-0023 §4 A3; owner msg 2715: "дефолтные значения
// для метаданных ... достаточно выбрать один раз"): a channel's publishing defaults -- publish time and zone, playlist, category,
// the status flags -- the same on every computer. One Automerge document per channel holding an OPAQUE map of values, like
// `media-settings`: which fields exist, their defaults and their validation are the publishing module's business; this family
// only carries the values and reports conflicts. It imports nothing from publishing (AGENTS.md §M).

/** A stored value: the publishing fields are strings ("15:00", a zone, an id), booleans, or null (no playlist). */
export type PublishingSettingValue = string | boolean | null;

export type ChannelPublishingSettingsDocument = {
  format: "ytm-channel-publishing-settings";
  version: 1;
  channelId: string;
  /** A field is absent until a computer saves it: the publishing module then shows its default. */
  settings: Record<string, PublishingSettingValue>;
};

/**
 * A field saved with DIFFERENT values on two computers before they met. The same value written on both is not a conflict
 * (Automerge records both writes; they are deduplicated here). `valuesByActor` keeps one writer per distinct value, which is
 * what a choice names. Until the owner chooses, both computers read Automerge's deterministic winner.
 */
export type PublishingSettingConflict = {
  field: string;
  values: PublishingSettingValue[];
  valuesByActor: Record<string, PublishingSettingValue>;
};

export type MergeResult = { newConflicts: PublishingSettingConflict[] };
