import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  deleteExperimentArmVideoIfEligible,
  getExperimentById,
  getHypothesisById,
  initializeDatabaseSchema,
  insertExperiment,
  insertExperimentArmVideoIfEligible,
  insertHypothesis,
  listExperimentArmVideos,
  listExperimentOutcomesByExperiment,
  listExperimentsByHypothesis,
  listHypothesisEvidenceByHypothesis,
  type AppDb,
} from "@/lib/db";
import { SNAPSHOT_TRANSFERRED_TABLES } from "@/lib/snapshot/contracts";
import { YOUTUBE_DATA_CLASSIFICATION } from "@/lib/youtube-data-policy/contracts";
import { DomainError, type ExperimentStatus } from "./contracts";
import { createDecisionEngineServices, groupExperimentArms } from "./services";

// BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md §3, AC-EA-01/02/03/08/10), on a real (temporary) database so the atomic insert and
// delete are what is tested. The owner's active channel is UC_A; UC_A's synced videos are v1..v60, UC_B's vB1.

const OWNER = { userId: "u-owner" };
const WEB = { ...OWNER, linkedBy: "u-owner", linkedVia: "web_ui" as const };
const NOW = new Date("2026-10-10T18:00:00Z");
const UC_A_VIDEOS = Array.from({ length: 60 }, (_, i) => `v${i + 1}`);

async function freshDb(): Promise<AppDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "experiment-arms-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  await initializeDatabaseSchema(client);
  return drizzle(client) as unknown as AppDb;
}

async function seed(db: AppDb) {
  for (const id of ["UC_A", "UC_B"]) {
    await db.run(sql`INSERT INTO channels (id, title, uploads_playlist_id, connected_at) VALUES (${id}, ${id}, ${`UU${id}`}, 0)`);
  }
  const hypothesis = (id: string, channelId: string | null) =>
    insertHypothesis({ id, channelId, statement: "s", evidenceNotes: "e", createdBy: "u-owner", createdVia: "web_ui" }, db);
  await hypothesis("hA", "UC_A");
  await hypothesis("hB", "UC_B");
  await hypothesis("h0", null);
  const experiment = (id: string, hypothesisId: string) =>
    insertExperiment({ id, hypothesisId, treatment: "t", controlBaseline: "c", successCriteria: "s", stoppingCriteria: "x", responsible: "owner", createdVia: "web_ui" }, db);
  for (const [id, hypothesisId] of [["E1", "hA"], ["E2", "hA"], ["EB", "hB"], ["E0", "h0"]]) await experiment(id, hypothesisId);
  await setStatus(db, "E1", "running");
}

async function setStatus(db: AppDb, experimentId: string, status: ExperimentStatus) {
  await db.run(sql`UPDATE experiments SET status = ${status} WHERE id = ${experimentId}`);
}

function services(db: AppDb) {
  return createDecisionEngineServices({
    idGenerator: () => "id",
    clock: { now: () => NOW },
    channelAccess: {
      assertActiveChannel: async ({ channelId }) => {
        if (channelId !== "UC_A") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
        return channelId;
      },
      getActiveChannelId: async () => "UC_A",
    },
    insertHypothesis: (input) => insertHypothesis(input, db),
    getHypothesisById: (id) => getHypothesisById(id, db),
    listHypotheses: async () => [],
    insertExperiment: (input) => insertExperiment(input, db),
    getExperimentById: (id) => getExperimentById(id, db),
    listExperimentsByHypothesis: (id) => listExperimentsByHypothesis(id, db),
    transitionExperimentStatusIfValid: async () => null,
    setExperimentChangeSetIfEligible: async () => null,
    claimExperimentForExecution: async () => null,
    releaseExperimentExecutionClaim: async () => false,
    finalizeExperimentExecution: async () => false,
    insertExperimentOutcome: async () => undefined,
    listExperimentOutcomesByExperiment: (id) => listExperimentOutcomesByExperiment(id, db),
    insertHypothesisEvidence: async () => undefined,
    listHypothesisEvidenceByHypothesis: (id) => listHypothesisEvidenceByHypothesis(id, db),
    insertHypothesisGenerationProvenance: async () => undefined,
    getHypothesisGenerationProvenanceByHypothesis: async () => null,
    listExperimentArmVideos: (ids) => listExperimentArmVideos(ids, db),
    insertExperimentArmVideoIfEligible: (row, from, max) => insertExperimentArmVideoIfEligible(row, from, max, db),
    deleteExperimentArmVideoIfEligible: (experimentId, videoId, from) => deleteExperimentArmVideoIfEligible(experimentId, videoId, from, db),
    listChannelVideoIds: async (channelId) => (channelId === "UC_A" ? UC_A_VIDEOS : channelId === "UC_B" ? ["vB1"] : []),
  });
}

const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

test("AC-EA-01: the owner links v1 to running E1 as A; the trail and the arms list show it, linked via the Web UI by the owner", async () => {
  const db = await freshDb();
  await seed(db);
  const de = services(db);
  const linked = await de.linkExperimentArmVideo("E1", { videoId: "v1", arm: "A" }, WEB);
  const expectedArms = [{ arm: "A", videos: [{ videoId: "v1", linkedAt: NOW.toISOString(), linkedBy: "u-owner", linkedVia: "web_ui" }] }];
  assert.deepEqual(linked, { experimentId: "E1", status: "running", channelId: "UC_A", arms: expectedArms });
  assert.deepEqual(await de.listExperimentArms("E1", OWNER), { experimentId: "E1", status: "running", channelId: "UC_A", arms: expectedArms });
  const trail = await de.getHypothesisTrail("hA", OWNER);
  assert.deepEqual(
    trail.experiments.map((experiment) => [experiment.experimentId, (experiment as { arms?: unknown }).arms]).sort(),
    [
      ["E1", expectedArms],
      ["E2", []],
    ]
  );
});

test("AC-EA-02: each refusal has its own code and writes nothing", async () => {
  const db = await freshDb();
  await seed(db);
  const de = services(db);
  const refused = async (experimentId: string, input: Record<string, unknown>, expected: string) => {
    await assert.rejects(() => de.linkExperimentArmVideo(experimentId, input, WEB), code(expected), `${experimentId} ${JSON.stringify(input)}`);
  };
  await refused("E0", { videoId: "v1", arm: "A" }, "EXPERIMENT_ARM_CHANNEL_REQUIRED");
  await refused("E1", { videoId: "vB1", arm: "A" }, "EXPERIMENT_ARM_VIDEO_NOT_FOUND");
  await refused("E1", { videoId: "never-synced", arm: "A" }, "EXPERIMENT_ARM_VIDEO_NOT_FOUND");
  for (const status of ["concluded", "abandoned"] as const) {
    await setStatus(db, "E2", status);
    await refused("E2", { videoId: "v1", arm: "A" }, "EXPERIMENT_ARMS_FROZEN");
  }
  for (const arm of ["", "x".repeat(33), "-x", "a/b"]) await refused("E1", { videoId: "v1", arm }, "validation_failed");
  await refused("nope", { videoId: "v1", arm: "A" }, "EXPERIMENT_NOT_FOUND");
  await refused("EB", { videoId: "vB1", arm: "A" }, "CHANNEL_NOT_ACTIVE");
  assert.deepEqual(await listExperimentArmVideos(["E0", "E1", "E2", "EB"], db), []);

  await de.linkExperimentArmVideo("E1", { videoId: "v1", arm: "A" }, WEB);
  await refused("E1", { videoId: "v1", arm: "B" }, "EXPERIMENT_ARM_VIDEO_ALREADY_LINKED");
  for (const videoId of UC_A_VIDEOS.slice(1, 50)) await de.linkExperimentArmVideo("E1", { videoId, arm: "B" }, WEB);
  assert.equal((await listExperimentArmVideos(["E1"], db)).length, 50);
  await refused("E1", { videoId: "v51", arm: "B" }, "EXPERIMENT_ARMS_FULL");
  assert.equal((await listExperimentArmVideos(["E1"], db)).length, 50, "the 51st was not written");
});

test("AC-EA-02 (labels): surrounding spaces are trimmed; 32 characters, digits and other alphabets are accepted", async () => {
  const db = await freshDb();
  await seed(db);
  const de = services(db);
  await de.linkExperimentArmVideo("E1", { videoId: "v1", arm: "  A  " }, WEB);
  await de.linkExperimentArmVideo("E1", { videoId: "v2", arm: "x".repeat(32) }, WEB);
  await de.linkExperimentArmVideo("E1", { videoId: "v3", arm: "контроль" }, WEB);
  await de.linkExperimentArmVideo("E1", { videoId: "v4", arm: "B-2 new_open" }, WEB);
  assert.deepEqual((await listExperimentArmVideos(["E1"], db)).map((row) => row.arm).sort(), ["A", "B-2 new_open", "x".repeat(32), "контроль"].sort());
});

test("AC-EA-03: a link of a running experiment is removed; one of a concluded experiment, or one that does not exist, is refused", async () => {
  const db = await freshDb();
  await seed(db);
  const de = services(db);
  await de.linkExperimentArmVideo("E1", { videoId: "v1", arm: "A" }, WEB);
  assert.deepEqual(await de.unlinkExperimentArmVideo("E1", "v1", OWNER), { experimentId: "E1", status: "running", channelId: "UC_A", arms: [] });
  await assert.rejects(() => de.unlinkExperimentArmVideo("E1", "v1", OWNER), code("EXPERIMENT_ARM_VIDEO_NOT_LINKED"));
  await de.linkExperimentArmVideo("E1", { videoId: "v2", arm: "A" }, WEB);
  await setStatus(db, "E1", "concluded");
  await assert.rejects(() => de.unlinkExperimentArmVideo("E1", "v2", OWNER), code("EXPERIMENT_ARMS_FROZEN"));
  assert.equal((await listExperimentArmVideos(["E1"], db)).length, 1);
});

test("AC-EA-08: after the experiment is concluded its arms stay readable, and adding or removing is refused", async () => {
  const db = await freshDb();
  await seed(db);
  const de = services(db);
  await de.linkExperimentArmVideo("E1", { videoId: "v1", arm: "control" }, WEB);
  await de.linkExperimentArmVideo("E1", { videoId: "v2", arm: "A" }, WEB);
  await setStatus(db, "E1", "concluded");
  const arms = (await de.listExperimentArms("E1", OWNER)).arms;
  assert.deepEqual(arms.map((arm) => [arm.arm, arm.videos.map((video) => video.videoId)]), [["control", ["v1"]], ["A", ["v2"]]]);
  const trail = await de.getHypothesisTrail("hA", OWNER);
  assert.deepEqual((trail.experiments.find((experiment) => experiment.experimentId === "E1") as { arms?: unknown } | undefined)?.arms, arms);
  await assert.rejects(() => de.linkExperimentArmVideo("E1", { videoId: "v3", arm: "A" }, WEB), code("EXPERIMENT_ARMS_FROZEN"));
  await assert.rejects(() => de.unlinkExperimentArmVideo("E1", "v1", OWNER), code("EXPERIMENT_ARMS_FROZEN"));
});

test("storage: the insert and the delete re-check the status, the cap and a repeat atomically", async () => {
  const db = await freshDb();
  await seed(db);
  const row = (videoId: string) => ({ experimentId: "E1", videoId, arm: "A", linkedBy: "u", linkedVia: "web_ui" as const, at: NOW });
  const linkable: ExperimentStatus[] = ["proposed", "approved", "running"];
  assert.equal(await insertExperimentArmVideoIfEligible(row("v1"), linkable, 2, db), true);
  assert.equal(await insertExperimentArmVideoIfEligible(row("v1"), linkable, 2, db), false, "repeat");
  assert.equal(await insertExperimentArmVideoIfEligible(row("v2"), linkable, 2, db), true);
  assert.equal(await insertExperimentArmVideoIfEligible(row("v3"), linkable, 2, db), false, "cap");
  assert.equal(await insertExperimentArmVideoIfEligible({ ...row("v3"), experimentId: "missing" }, linkable, 50, db), false, "no experiment");
  await setStatus(db, "E1", "concluded");
  assert.equal(await insertExperimentArmVideoIfEligible(row("v3"), linkable, 50, db), false, "frozen");
  assert.equal(await deleteExperimentArmVideoIfEligible("E1", "v1", linkable, db), false, "frozen");
  await setStatus(db, "E1", "running");
  assert.equal(await deleteExperimentArmVideoIfEligible("E1", "v1", linkable, db), true);
  assert.equal(await deleteExperimentArmVideoIfEligible("E1", "v1", linkable, db), false, "gone");
  assert.deepEqual((await listExperimentArmVideos(["E1"], db)).map((r) => [r.videoId, r.linkedAt.toISOString()]), [["v2", NOW.toISOString()]]);
});

test("AC-EA-04 (decision engine side): a Producer proposal is checked against the proposal's channel, not the owner's active channel", async () => {
  const db = await freshDb();
  await seed(db);
  const de = services(db);
  await de.checkExperimentArmVideoProposal({ channelId: "UC_A", experimentId: "E1", videoId: "v2", arm: "control" });
  // UC_B is not the owner's active channel, yet its own experiment can be proposed for.
  await de.checkExperimentArmVideoProposal({ channelId: "UC_B", experimentId: "EB", videoId: "vB1", arm: "A" });
  const refused = (input: { channelId: string; experimentId: string; videoId: string; arm: string }, expected: string) =>
    assert.rejects(() => de.checkExperimentArmVideoProposal(input), code(expected), JSON.stringify(input));
  await refused({ channelId: "UC_B", experimentId: "E1", videoId: "v2", arm: "A" }, "EXPERIMENT_NOT_FOUND");
  await refused({ channelId: "UC_A", experimentId: "E1", videoId: "vB1", arm: "A" }, "EXPERIMENT_ARM_VIDEO_NOT_FOUND");
  await refused({ channelId: "UC_A", experimentId: "E1", videoId: "v2", arm: "-" }, "validation_failed");
  await de.linkExperimentArmVideo("E1", { videoId: "v2", arm: "A" }, WEB);
  await refused({ channelId: "UC_A", experimentId: "E1", videoId: "v2", arm: "B" }, "EXPERIMENT_ARM_VIDEO_ALREADY_LINKED");
  await setStatus(db, "E2", "concluded");
  await refused({ channelId: "UC_A", experimentId: "E2", videoId: "v3", arm: "A" }, "EXPERIMENT_ARMS_FROZEN");
  assert.equal((await listExperimentArmVideos(["E1", "E2", "EB"], db)).length, 1, "checking writes nothing");
});

test("groupExperimentArms: control first, then by label; videos in the order they were linked", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 18, minute));
  const row = (videoId: string, arm: string, minute: number) => ({ experimentId: "E1", videoId, arm, linkedBy: "u", linkedVia: "web_ui" as const, linkedAt: at(minute) });
  assert.deepEqual(
    groupExperimentArms([row("v3", "B", 3), row("v1", "A", 2), row("v0", "control", 5), row("v2", "A", 1)]).map((arm) => [arm.arm, arm.videos.map((video) => video.videoId)]),
    [
      ["control", ["v0"]],
      ["A", ["v2", "v1"]],
      ["B", ["v3"]],
    ]
  );
});

test("AC-EA-10: experiment_arm_videos travels in the device snapshot after experiments, and is YT Manager's own data", () => {
  const order = [...SNAPSHOT_TRANSFERRED_TABLES];
  assert.ok(order.indexOf("experiment_arm_videos") > order.indexOf("experiments"));
  assert.equal(YOUTUBE_DATA_CLASSIFICATION.experiment_arm_videos?.kind, YOUTUBE_DATA_CLASSIFICATION.experiments?.kind);
});
