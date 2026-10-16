import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createMediaSettingsCore, emptyDocumentOf, GEMINI_SETTINGS_KIND, type MediaSettingsCore, type MediaSettingsDocument } from "../media-settings";

// BL-193 (owner, Telegram 2026-10-16, msg 2867: Gemini limits "да, общие"; ADR 0039): the Gemini limits, the same on every computer.
// The same opaque settings-map engine as `media-settings` (ADR 0030) on its OWN document: which fields are shared and how a received
// value is applied is gemini-media's business, as the Setup fields are media-generation's -- a separate document keeps each
// map with one owner. Imports nothing from gemini-media (AGENTS.md §M).

const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.geminiSettingsCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: MediaSettingsCore };

export type GeminiSettingsCore = MediaSettingsCore;

export function createGeminiSettingsCoreForProduction(): GeminiSettingsCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.geminiSettingsDocDir);
    holder[PRODUCTION_KEY] = createMediaSettingsCore(
      {
        core: createAutomergeCore<MediaSettingsDocument>({
          store,
          discardedBackupStore: createDiscardedDocumentBackupStore(paths.geminiSettingsDiscardedBackupsDir),
          emptyDocument: () => emptyDocumentOf(GEMINI_SETTINGS_KIND),
        }),
        store,
      },
      GEMINI_SETTINGS_KIND
    );
  }
  return holder[PRODUCTION_KEY];
}
