import { readFile } from "node:fs/promises";
import { rawSqlClient } from "@/lib/db";
import { getDeviceSecrets } from "@/lib/device-secrets";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createTelegramBotGateway } from "@/lib/telegram-bot-gateway";
import type { BotTokenPort } from "./contracts";
import { createBotGetUpdatesInbox } from "./adapters/bot-get-updates-inbox";
import { runFactoryProcess } from "./adapters/process";
import { createSystemTopicStore } from "./adapters/store";
import { createSystemTopic, type SystemTopic } from "./services";

// BL-228 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md, ADR 0053): the System topic module wired to this computer -- its tables, the
// device-secrets slot `telegram_system_bot`, the Telegram gateway, the factory's config file, the channel workspaces and the child
// process runner. Off by default; the rest of the app never depends on it (AGENTS.md §M).

/** Between two polls while the switch is off (or the settings are incomplete): a local read only, no Telegram call. */
export const SYSTEM_TOPIC_IDLE_TICK_MS = 5_000;
/** After a failed poll (Telegram unreachable, a refused token): wait before the next one. */
export const SYSTEM_TOPIC_ERROR_BACKOFF_MS = 30_000;

/** The Mac service: the only place the switch may be on (two computers polling one bot steal each other's updates). */
export function isSystemTopicServiceMode(): boolean {
  return process.env.YTOM_SERVICE_MODE === "1" && process.platform === "darwin";
}

function tokenPort(): BotTokenPort {
  const slot = getDeviceSecrets().slot("telegram_system_bot");
  return {
    read: () => slot.read(),
    hasToken: async () => (await slot.state()) === "set",
    botId: async () => (await slot.info())?.hints.botId ?? null,
    write: async (token) => {
      await slot.write(token, { hints: { botId: token.split(":")[0] ?? null }, status: null });
    },
    clear: () => slot.clear(),
  };
}

async function readConfigFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const CORE_KEY = Symbol.for("youtube-operations-manager.system-topic");

/** One instance per process (the routes and the server's poll loop are separate bundles). */
export function createSystemTopicCore(): SystemTopic {
  const holder = globalThis as unknown as Record<symbol, SystemTopic | undefined>;
  const existing = holder[CORE_KEY];
  if (existing) return existing;
  const logger = createDefaultLogger();
  const workspaces = createChannelWorkspacesCore();
  const gateway = createTelegramBotGateway();
  const token = tokenPort();
  const core = createSystemTopic({
    store: createSystemTopicStore(rawSqlClient),
    replies: gateway,
    // Owner msg 3602: the HUB bot may be polled by the HUB process already, so getUpdates is one source the owner picks, never
    // the default (`none`). A HUB hand-over source is expected later (one more entry here).
    inboxes: { bot_get_updates: createBotGetUpdatesInbox({ getUpdates: (t, input) => gateway.getUpdates(t, input), readToken: () => token.read() }) },
    token,
    readConfigFile,
    channelWorkspacePath: async (channelId) => {
      const result = await workspaces.getWorkspace({ channelId });
      return result.configured ? result.path : null;
    },
    runProcess: runFactoryProcess,
    serviceMode: isSystemTopicServiceMode,
    clock: () => Date.now(),
    log: (event, context) => logger.info({ event, context }),
  });
  holder[CORE_KEY] = core;
  return core;
}

export * from "./contracts";
export { parseSystemCommand } from "./parser";
export type { SystemTopic } from "./services";
