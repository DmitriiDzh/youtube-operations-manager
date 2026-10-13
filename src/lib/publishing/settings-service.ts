import { effectivePublishingSettings, DEFAULT_PUBLISHING_SETTINGS, type PublishingSettingField, type PublishingSettings } from "./settings";

/** The synced values of one channel (the sync-gateway `channel-publishing-settings` family, injected). */
export type PublishingSettingsStore = {
  read(channelId: string): Promise<{ values: Record<string, unknown>; conflicts: Array<{ field: string; values: unknown[] }> }>;
  save(channelId: string, patch: Record<string, string | boolean | string[] | null>): Promise<{ changed: string[] }>;
};

export type PublishingSettingsView = {
  channelId: string;
  settings: PublishingSettings;
  defaults: PublishingSettings;
  /** The fields a computer saved; the others show their default. */
  saved: PublishingSettingField[];
  /** Fields saved differently on two computers: both read the same value until the owner keeps one in Merge. */
  conflictedFields: string[];
};

/** BL-182 stage 2: a channel's publishing defaults as the Content panel and the uploads read them, and the panel's save. */
export function createPublishingSettingsService(deps: { store: PublishingSettingsStore }) {
  async function read(channelId: string): Promise<PublishingSettingsView> {
    const { values, conflicts } = await deps.store.read(channelId);
    const { settings, saved } = effectivePublishingSettings(values);
    return { channelId, settings, defaults: DEFAULT_PUBLISHING_SETTINGS, saved, conflictedFields: conflicts.map((c) => c.field) };
  }
  return {
    read,
    /** `patch` is already validated (`parsePublishingSettingsPatch`); only the fields the owner changed are sent. */
    async save(channelId: string, patch: Partial<PublishingSettings>): Promise<PublishingSettingsView> {
      await deps.store.save(channelId, patch as Record<string, string | boolean | string[] | null>);
      return read(channelId);
    },
  };
}

export type PublishingSettingsService = ReturnType<typeof createPublishingSettingsService>;
