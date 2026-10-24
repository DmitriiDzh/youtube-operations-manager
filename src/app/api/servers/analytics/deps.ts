import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listStoredChannels } from "@/lib/db";
import { buildHistory, buildSummary, readSpendInputs } from "@/lib/spend-analytics";
import type { SpendAnalyticsRouteDeps } from "./handlers";

// BL-219: the real dependencies of the Servers → «Аналитика» routes (the handlers are tested with fakes).
export const productionDeps: SpendAnalyticsRouteDeps = {
  getSession: () => getServerSession(authOptions),
  readInputs: readSpendInputs,
  summary: buildSummary,
  history: buildHistory,
  now: () => new Date(),
  channelTitles: async () => (await listStoredChannels()).map((channel) => ({ channelId: channel.channelId, title: channel.title })),
};
