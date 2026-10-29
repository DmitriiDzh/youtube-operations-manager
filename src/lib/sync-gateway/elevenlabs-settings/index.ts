import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createMediaSettingsCore, emptyDocumentOf, ELEVENLABS_SETTINGS_KIND, type MediaSettingsCore, type MediaSettingsDocument } from "../media-settings";

// BL-236 (owner, Telegram 2026-10-29, msg 3823: "как у других API"; ADR 0057): the ElevenLabs character limits, the same on every computer, exactly as the Gemini limits (ADR 0039).
// The same opaque settings-map engine as `media-settings` (ADR 0030) on its OWN document: which fields are shared and how a received
// value is applied is elevenlabs-speech's business, as the Setup fields are media-generation's -- a separate document keeps each
// map with one owner. Imports nothing from elevenlabs-speech (AGENTS.md §M).

const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.elevenlabsSettingsCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: MediaSettingsCore };

export type ElevenlabsSettingsCore = MediaSettingsCore;

export function createElevenlabsSettingsCoreForProduction(): ElevenlabsSettingsCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.elevenlabsSettingsDocDir);
    holder[PRODUCTION_KEY] = createMediaSettingsCore(
      {
        core: createAutomergeCore<MediaSettingsDocument>({
          store,
          discardedBackupStore: createDiscardedDocumentBackupStore(paths.elevenlabsSettingsDiscardedBackupsDir),
          emptyDocument: () => emptyDocumentOf(ELEVENLABS_SETTINGS_KIND),
        }),
        store,
      },
      ELEVENLABS_SETTINGS_KIND
    );
  }
  return holder[PRODUCTION_KEY];
}
