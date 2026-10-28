import { realpath, readFile, stat } from "node:fs/promises";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getWeeklyBuildSettingsJson, setWeeklyBuildSettingsJson } from "@/lib/db";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { findPython, runScript, scriptEnv } from "./host";
import { createWeeklyBuildServices, type WeeklyBuildService } from "./services";
import { createWeeklyBuildSettings } from "./settings";

// BL-231 (WEEKLY_BUILD_BUTTON_PLAN.md): the owner's weekly-build core. One instance per process (kept on globalThis: the routes
// are compiled separately, and the start/stop lock and the check cache must be shared by all of them). Only the Web routes
// under /api/channels/[channelId]/weekly-build and /api/weekly-build use it -- no MCP tool (no-agent.test.ts).

export function createWeeklyBuildSettingsCore() {
  return createWeeklyBuildSettings({ getJson: () => getWeeklyBuildSettingsJson(), setJson: (json) => setWeeklyBuildSettingsJson(json) });
}

const KEY = Symbol.for("ytm.weeklyBuild.core");
type GlobalWithCore = typeof globalThis & { [KEY]?: WeeklyBuildService };

export function createWeeklyBuildCore(): WeeklyBuildService {
  const holder = globalThis as GlobalWithCore;
  if (holder[KEY]) return holder[KEY];
  const workspaces = createChannelWorkspacesCore();
  const settings = createWeeklyBuildSettingsCore();
  const core = createWeeklyBuildServices({
    getWorkspace: (channelId) => workspaces.getWorkspace({ channelId }),
    getSettings: () => settings.get(),
    findPython: (configured) => findPython({ configured }),
    run: runScript,
    env: () => scriptEnv(process.env, process.platform),
    fs: {
      realpath: (p) => realpath(p),
      stat: async (p) => {
        const s = await stat(p);
        return { isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
      },
      readFile: (p) => readFile(p, "utf8"),
    },
    isPathInsideOrEqual,
    now: () => Date.now(),
  });
  holder[KEY] = core;
  return core;
}

export type { WeeklyBuildService } from "./services";
export * from "./contracts";
export { isDomainError } from "@/lib/shared-domain";
