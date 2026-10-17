import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "./contracts";
import { createGenerationPlanServices, type PlanStore, type StoredPlan } from "./services";

// BL-194 stage 1 (VIDEO_COST_PLAN.md §2 "Where a number is used", criterion 2): a plan may name the channel's video it works for
// (`videoNumber` on factory_plan_create / factory_plan_update, the owner's picker). A number the channel cannot link to is refused.

const CHANNEL = "UC_plan_channel";
const OTHER = "UC_other_channel";

function setup(attachable: Record<string, string[]>) {
  const plans = new Map<string, StoredPlan>();
  const store = {
    async insertPlan(row: StoredPlan) {
      if (plans.has(row.id)) return null;
      plans.set(row.id, structuredClone(row));
      return structuredClone(row);
    },
    getPlan: async (id: string) => (plans.has(id) ? structuredClone(plans.get(id)!) : null),
    listPlans: async () => [...plans.values()].map((p) => structuredClone(p)),
    async updatePlan(id: string, expectedRevision: number, set: Partial<StoredPlan>) {
      const row = plans.get(id);
      if (!row || row.revision !== expectedRevision) return null;
      const next = { ...row, ...structuredClone(set), revision: expectedRevision + 1 } as StoredPlan;
      plans.set(id, next);
      return structuredClone(next);
    },
    upsertResults: async () => {},
    listResults: async () => [],
    insertEvent: async () => {},
    listEvents: async () => [],
    listJobs: async () => [],
    linkJob: async () => false,
    listSessions: async () => [],
    insertPeerVerdict: async () => {},
    listPeerVerdicts: async () => [],
    insertPeerGroupNote: async () => {},
    listPeerGroupNotes: async () => [],
    insertVerdictHistory: async () => {},
    listVerdictHistory: async () => [],
    upsertClaim: async () => {},
    deleteClaim: async () => {},
    listClaims: async () => [],
    insertRecheck: async () => true,
    listRechecks: async () => [],
    closeRecheck: async () => false,
    replaceRecheckAnswer: async () => false,
    listPicks: async () => [],
    upsertPicks: async () => {},
    insertPeerPick: async () => {},
    listPeerPicks: async () => [],
  } as unknown as PlanStore;
  let ms = Date.parse("2026-10-17T10:00:00.000Z");
  const services = createGenerationPlanServices({
    store,
    channels: { isConnected: async (id) => id === CHANNEL || id === OTHER },
    clock: { now: () => new Date((ms += 1000)) },
    videos: {
      async assertAttachable(channelId, video) {
        if (!(attachable[channelId] ?? []).includes(video)) {
          const { DomainError } = await import("./contracts");
          throw new DomainError({ code: "video_not_found", message: `${video} is not a video of ${channelId}` });
        }
        return video;
      },
    },
  });
  return { services, plans };
}

const plan = (extra: Record<string, unknown> = {}) => ({
  planId: "P-49",
  title: "Video 49 visuals",
  channelId: CHANNEL,
  stages: [{ stageId: "generate", title: "Generate", kind: "in_app" as const }],
  ...extra,
});
const refused = (code: string) => (e: unknown) => isDomainError(e) && e.code === code;

test("BL-194: a plan created for V49 of its channel keeps it; another channel's number is refused and no plan is made", async () => {
  const { services, plans } = setup({ [CHANNEL]: ["V49"], [OTHER]: ["V50"] });
  await assert.rejects(services.createPlan(plan({ planId: "P-50", videoNumber: "V50" })), refused("video_not_found"));
  await assert.rejects(services.createPlan(plan({ planId: "P-x", videoNumber: "V049" })), refused("validation_failed"));
  assert.equal(plans.size, 0);
  const created = await services.createPlan(plan({ videoNumber: "V49" }));
  assert.equal(created.plan.video, "V49");
  assert.equal(plans.get("P-49")!.video, "V49");
});

test("BL-194: a plan without a video shows null; an update sets, keeps or clears it", async () => {
  const { services } = setup({ [CHANNEL]: ["V49", "V51"] });
  assert.equal((await services.createPlan(plan())).plan.video, null);
  assert.equal((await services.updatePlan({ planId: "P-49", videoNumber: "V51" }, "owner")).plan.video, "V51");
  assert.equal((await services.updatePlan({ planId: "P-49", title: "Renamed" })).plan.video, "V51", "absent keeps it");
  await assert.rejects(services.updatePlan({ planId: "P-49", videoNumber: "V77" }, "owner"), refused("video_not_found"));
  assert.equal((await services.getPlan({ planId: "P-49" })).plan.video, "V51", "a refusal changes nothing");
  assert.equal((await services.updatePlan({ planId: "P-49", videoNumber: null }, "owner")).plan.video, null);
});
