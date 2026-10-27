import { readFile } from "node:fs/promises";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs } from "@/lib/workspace-exchange";
import { createMusicLibraryFiles } from "./adapters/files";
import { createMusicLibraryService, type MusicLibraryService } from "./services";

// BL-229 part A (ADR 0054, AGENTS.md §M): a feature module of its own -- Media and everything else works without it; only the
// library card and its route use it.

export function createMusicLibraryServiceForProduction(): MusicLibraryService {
  return createMusicLibraryService({
    getWorkspace: (channelId) => createChannelWorkspacesCore().getWorkspace({ channelId }),
    files: createMusicLibraryFiles({
      fs: createExchangeFs(),
      validateWorkspacePath: validateOperatorDirectoryPath,
      isPathInsideOrEqual,
      readFile: (filePath) => readFile(filePath, "utf8"),
    }),
    now: () => new Date(),
  });
}

export { acceptancePercentOf, buildView, createMusicLibraryService, hoursOf, isStale, parseSnapshot } from "./services";
export type { MusicLibraryService } from "./services";
export { createMusicLibraryFiles } from "./adapters/files";
export * from "./contracts";
export * from "./schemas";
