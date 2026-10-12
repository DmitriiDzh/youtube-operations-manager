import assert from "node:assert/strict";
import test from "node:test";
import { createLocalizationAlertsHandler, type LocalizationAlertsDeps } from "./route";

// BL-178 part C (LOCALIZATION_BASELINE_PLAN §3.3 C2): a Web session is required; every connected channel's counts come back
// with the active channel named (badge vs bell); a channel that cannot be read is left out, never failing the others.

const deps = (overrides: Partial<LocalizationAlertsDeps> = {}): LocalizationAlertsDeps => ({
  getSession: async () => ({ user: { id: "u1" } }),
  activeChannelId: async () => "UC_A",
  connectedChannelIds: async () => ["UC_A", "UC_B", "UC_never_synced"],
  alertsFor: async (channelId) => {
    if (channelId === "UC_never_synced") throw new Error("Channel has not been synchronized yet");
    const none: Record<string, number> = {};
    return channelId === "UC_A"
      ? { missingVideoCount: 2, missingByLanguage: { es: 2, "pt-BR": 1 }, deviationCount: 1, attentionVideoCount: 2 }
      : { missingVideoCount: 0, missingByLanguage: none, deviationCount: 0, attentionVideoCount: 0 };
  },
  ...overrides,
});

test("401 without a session; with one, every readable connected channel's counts and the active channel", async () => {
  assert.equal((await createLocalizationAlertsHandler(deps({ getSession: async () => null }))()).status, 401);
  const res = await createLocalizationAlertsHandler(deps())();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    activeChannelId: "UC_A",
    channels: [
      { channelId: "UC_A", missingVideoCount: 2, missingByLanguage: { es: 2, "pt-BR": 1 }, deviationCount: 1, attentionVideoCount: 2 },
      { channelId: "UC_B", missingVideoCount: 0, missingByLanguage: {}, deviationCount: 0, attentionVideoCount: 0 },
    ],
  });
});
