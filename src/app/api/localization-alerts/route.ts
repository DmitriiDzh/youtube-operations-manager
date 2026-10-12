import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelLanguageDefaultsCore } from "@/lib/channel-language-defaults";
import { createLocalizationCore } from "@/lib/localization";

export type LocalizationAlertChannel = {
  channelId: string;
  /** Public or scheduled videos lacking a tracked language (measured against the channel's language). */
  missingVideoCount: number;
  /** Per language, how many of those videos lack it. */
  missingByLanguage: Record<string, number>;
  /** Synced videos whose language fields differ from the channel's baseline (the Languages page's "Fix all" list). */
  deviationCount: number;
};

export type LocalizationAlertsDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  activeChannelId: (userId: string) => Promise<string | null>;
  connectedChannelIds: (userId: string) => Promise<string[]>;
  alertsFor: (channelId: string) => Promise<Omit<LocalizationAlertChannel, "channelId">>;
};

export function defaultLocalizationAlertsDeps(): LocalizationAlertsDeps {
  const localization = createLocalizationCore();
  const languageDefaults = createChannelLanguageDefaultsCore();
  return {
    getSession: () => getServerSession(authOptions),
    activeChannelId: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    connectedChannelIds: async (userId) => (await createChannelConnectionsCore().listConnectedChannels(userId)).map((c) => c.channelId),
    async alertsFor(channelId) {
      const [missing, deviations] = await Promise.all([localization.getTranslationAlerts({ channelId }), languageDefaults.getDeviations({ channelId })]);
      return { missingVideoCount: missing.videos.length, missingByLanguage: missing.byLanguage, deviationCount: deviations.deviations.length };
    },
  };
}

/**
 * BL-178 part C (LOCALIZATION_BASELINE_PLAN §3.3 C2, FO-REQ-0022 §6): every connected channel's translation alerts -- counts and
 * language codes only -- for the «Языки» badge (the active channel) and the bell (the others). Derived from the local copy on
 * every poll, so an alert goes away by itself once the translations are applied. A local read: never a YouTube call. A channel
 * that cannot be read (never synced) is left out rather than failing the whole answer.
 */
export function createLocalizationAlertsHandler(deps: LocalizationAlertsDeps = defaultLocalizationAlertsDeps()) {
  return async (): Promise<NextResponse> => {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const [activeChannelId, channelIds] = await Promise.all([deps.activeChannelId(userId), deps.connectedChannelIds(userId)]);
      const settled = await Promise.allSettled(channelIds.map(async (channelId) => ({ channelId, ...(await deps.alertsFor(channelId)) })));
      const channels = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      return NextResponse.json({ activeChannelId, channels });
    } catch (error) {
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createLocalizationAlertsHandler();
