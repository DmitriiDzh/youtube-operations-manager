import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPathValidationFsAdapter } from "@/lib/local-path-validation/adapters/fs";
import { validateWorkspacePath } from "@/lib/local-path-validation/services";
import { isDomainError } from "./contracts";
import { createChannelWorkspacesServices, type ChannelWorkspaceStore } from "./services";

// Expected behavior comes from docs/roadmap/plans/PHASE_11_PLAN.md §3 (AC-P11-01..05, 07, 09),
// which was written before this module. It is not derived from the implementation.

const DEVICE = "device-this";

function createMemoryStore() {
  const rows = new Map<string, { path: string; updatedAt: Date }>();
  let setCalls = 0;
  const store: ChannelWorkspaceStore = {
    async get(deviceId, channelId) {
      return rows.get(`${deviceId}|${channelId}`)?.path ?? null;
    },
    async list(deviceId) {
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(`${deviceId}|`))
        .map(([key, value]) => ({ channelId: key.split("|")[1], ...value }));
    },
    async set(deviceId, channelId, value) {
      setCalls++;
      if (value === null) rows.delete(`${deviceId}|${channelId}`);
      else rows.set(`${deviceId}|${channelId}`, { path: value, updatedAt: new Date("2026-09-30T00:00:00Z") });
    },
  };
  return { store, rows, setCallCount: () => setCalls };
}

async function withDirs(run: (dirs: { root: string; workspace: string; appData: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "channel-workspaces-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const appData = path.join(root, "app-data");
    await mkdir(workspace);
    await mkdir(appData);
    await run({ root, workspace, appData });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createServices(appDataDir: string, connected = ["UC_A", "UC_B"]) {
  const memory = createMemoryStore();
  const services = createChannelWorkspacesServices({
    getDeviceId: async () => DEVICE,
    store: memory.store,
    listConnectedChannelIds: async () => connected,
    validatePath: (candidate) => validateWorkspacePath(candidate, { appDataDir, ...createPathValidationFsAdapter() }),
  });
  return { services, memory };
}

async function assertRejectsWithCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

test("AC-P11-01/07: a valid directory is stored and read back as exactly the same string", () =>
  withDirs(async ({ workspace, appData }) => {
    const { services } = createServices(appData);
    assert.deepEqual(await services.setWorkspace({ channelId: "UC_A", path: workspace }), { configured: true, path: workspace });
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: true, path: workspace });
  }));

test("AC-P11-07: an unconfigured channel reads as { configured: false }, never an empty path", () =>
  withDirs(async ({ appData }) => {
    const { services } = createServices(appData);
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: false });
  }));

test("AC-P11-02: every set-time rejection stores nothing", () =>
  withDirs(async ({ root, appData }) => {
    const { services, memory } = createServices(appData);
    const file = path.join(root, "file.txt");
    await writeFile(file, "x");
    const rejected = [
      "relative/path",
      path.join(root, "does-not-exist"),
      file,
      appData,
      path.join(appData, "..", "app-data"),
      root, // an ancestor of the app-data directory
    ];
    await mkdir(path.join(appData, "inner"));
    rejected.push(path.join(appData, "inner"));

    for (const candidate of rejected) {
      await assertRejectsWithCode(services.setWorkspace({ channelId: "UC_A", path: candidate }), "CHANNEL_WORKSPACE_PATH_INVALID");
    }
    assert.equal(memory.setCallCount(), 0);
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: false });
  }));

test("AC-P11-03: a channel that is not connected is rejected before any validation or storage", () =>
  withDirs(async ({ workspace, appData }) => {
    const { services, memory } = createServices(appData);
    await assertRejectsWithCode(
      services.setWorkspace({ channelId: "UC_NOT_CONNECTED", path: workspace }),
      "CHANNEL_WORKSPACE_CHANNEL_NOT_CONNECTED"
    );
    await assertRejectsWithCode(
      services.setWorkspace({ channelId: "UC_NOT_CONNECTED", path: null }),
      "CHANNEL_WORKSPACE_CHANNEL_NOT_CONNECTED"
    );
    assert.equal(memory.setCallCount(), 0);
  }));

test("AC-P11-04/05: clearing with null or blank removes only that channel's value", () =>
  withDirs(async ({ workspace, appData }) => {
    const { services } = createServices(appData);
    await services.setWorkspace({ channelId: "UC_A", path: workspace });
    await services.setWorkspace({ channelId: "UC_B", path: workspace });

    assert.deepEqual(await services.setWorkspace({ channelId: "UC_A", path: null }), { configured: false });
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: false });
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_B" }), { configured: true, path: workspace });

    await services.setWorkspace({ channelId: "UC_A", path: workspace });
    assert.deepEqual(await services.setWorkspace({ channelId: "UC_A", path: "   " }), { configured: false });
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: false });
  }));

test("AC-P11-09: the read never touches the filesystem -- a deleted directory still reads back as stored", () =>
  withDirs(async ({ workspace, appData }) => {
    const { services } = createServices(appData);
    await services.setWorkspace({ channelId: "UC_A", path: workspace });
    await rm(workspace, { recursive: true, force: true });
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: true, path: workspace });
  }));

test("AC-P11-10: the read input is strict -- an extra path field is rejected, not ignored", () =>
  withDirs(async ({ workspace, appData }) => {
    const { services, memory } = createServices(appData);
    await assertRejectsWithCode(services.getWorkspace({ channelId: "UC_A", path: workspace }), "validation_failed");
    assert.equal(memory.setCallCount(), 0);
  }));

test("listWorkspaces: one entry per connected channel, unset ones as null, disconnected channels' rows hidden", () =>
  withDirs(async ({ workspace, appData }) => {
    const { services, memory } = createServices(appData, ["UC_A", "UC_B"]);
    await services.setWorkspace({ channelId: "UC_A", path: workspace });
    await memory.store.set(DEVICE, "UC_GONE", "/stale/path");
    await memory.store.set("device-other", "UC_B", "/other/device");

    assert.deepEqual(await services.listWorkspaces(), [
      { channelId: "UC_A", path: workspace, updatedAt: "2026-09-30T00:00:00.000Z" },
      { channelId: "UC_B", path: null, updatedAt: null },
    ]);
  }));
