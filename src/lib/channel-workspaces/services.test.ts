import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    readDeviceId: async () => DEVICE,
    ensureDeviceId: async () => DEVICE,
    store: memory.store,
    listConnectedChannelIds: async () => connected,
    validatePath: (candidate) => validateWorkspacePath(candidate, { appDataDir, ...createPathValidationFsAdapter() }),
    realpath: (candidate) => realpath(candidate),
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

// BL-272 (review): two channels may no longer share one folder (CHANNEL_WORKSPACE_NESTED below), so UC_B has a folder of its own;
// what the test checks -- clearing touches only that channel's value -- is unchanged.
test("AC-P11-04/05: clearing with null or blank removes only that channel's value", () =>
  withDirs(async ({ root, workspace, appData }) => {
    const { services } = createServices(appData);
    const workspaceB = path.join(root, "workspace-b");
    await mkdir(workspaceB);
    await services.setWorkspace({ channelId: "UC_A", path: workspace });
    await services.setWorkspace({ channelId: "UC_B", path: workspaceB });

    assert.deepEqual(await services.setWorkspace({ channelId: "UC_A", path: null }), { configured: false });
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: false });
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_B" }), { configured: true, path: workspaceB });

    await services.setWorkspace({ channelId: "UC_A", path: workspace });
    assert.deepEqual(await services.setWorkspace({ channelId: "UC_A", path: "   " }), { configured: false });
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: false });
  }));

// BL-272 (review, ADR 0076 §3): a channel's folder is a folder of its own -- a path inside another connected channel's folder, around
// it, or the same folder (also through a symlink) is refused and nothing is stored; a sibling whose name only starts the same is fine,
// and so is re-setting a channel's own folder. A disconnected channel's stale row never blocks (it cannot be cleared in Settings).
test("BL-272: a workspace inside, around or equal to another connected channel's workspace is refused; siblings pass", () =>
  withDirs(async ({ root: tmp, appData }) => {
    const { services, memory } = createServices(appData, ["UC_A", "UC_B", "UC_C"]);
    // The channels' parent folder (the temp root itself holds the app-data folder, refused for its own reason).
    const root = path.join(tmp, "YouTube");
    const tropico = path.join(root, "01 Tropico");
    const inner = path.join(tropico, "Scenes");
    const sibling = path.join(root, "01 Tropico Jazz");
    const link = path.join(root, "tropico-link");
    await mkdir(inner, { recursive: true });
    await mkdir(sibling);
    await symlink(tropico, link);
    await services.setWorkspace({ channelId: "UC_A", path: tropico });

    for (const candidate of [inner, tropico, link, root]) {
      await assert.rejects(services.setWorkspace({ channelId: "UC_B", path: candidate }), (error: unknown) => isDomainError(error) && error.code === "CHANNEL_WORKSPACE_NESTED" && (error.details as { otherChannelId?: string }).otherChannelId === "UC_A", candidate);
    }
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_B" }), { configured: false });

    // The other direction: UC_B's folder first, then UC_C around it.
    assert.deepEqual(await services.setWorkspace({ channelId: "UC_B", path: sibling }), { configured: true, path: sibling });
    await assert.rejects(services.setWorkspace({ channelId: "UC_C", path: root }), (error: unknown) => isDomainError(error) && error.code === "CHANNEL_WORKSPACE_NESTED");
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_C" }), { configured: false });

    // A channel may set its own folder again, or a folder inside its own.
    assert.deepEqual(await services.setWorkspace({ channelId: "UC_A", path: tropico }), { configured: true, path: tropico });
    assert.deepEqual(await services.setWorkspace({ channelId: "UC_A", path: inner }), { configured: true, path: inner });

    // A disconnected channel's row and another device's row are not compared.
    await memory.store.set(DEVICE, "UC_GONE", root);
    await memory.store.set("device-other", "UC_C", root);
    const elsewhere = path.join(root, "03 Elsewhere");
    await mkdir(elsewhere);
    assert.deepEqual(await services.setWorkspace({ channelId: "UC_C", path: elsewhere }), { configured: true, path: elsewhere });
  }));

test("BL-272: another channel's folder that cannot be resolved now (disk not mounted) is compared as written", () =>
  withDirs(async ({ root: tmp, appData }) => {
    const { services, memory } = createServices(appData);
    const root = path.join(tmp, "YouTube");
    await mkdir(root);
    const real = await realpath(root);
    await memory.store.set(DEVICE, "UC_A", path.join(real, "unmounted", "01 Tropico"));
    await mkdir(path.join(root, "unmounted", "01 Tropico", "inner"), { recursive: true });
    // Now it exists again and UC_B tries a folder inside it: refused (realpath of both sides).
    await assert.rejects(services.setWorkspace({ channelId: "UC_B", path: path.join(root, "unmounted", "01 Tropico", "inner") }), (error: unknown) => isDomainError(error) && error.code === "CHANNEL_WORKSPACE_NESTED");
    await memory.store.set(DEVICE, "UC_A", path.join(real, "gone", "01 Tropico"));
    // Its folder is gone: a candidate around where it was is still refused (path.resolve comparison), a sibling passes.
    await assert.rejects(services.setWorkspace({ channelId: "UC_B", path: root }), (error: unknown) => isDomainError(error) && error.code === "CHANNEL_WORKSPACE_NESTED");
    assert.deepEqual(await services.setWorkspace({ channelId: "UC_B", path: path.join(root, "unmounted") }), { configured: true, path: path.join(root, "unmounted") });
  }));

test("AC-P11-09: the read never touches the workspace path -- a deleted directory still reads back as stored", () =>
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

// Review round 1, finding 1: a read must never create the device identity as a side effect (the
// agent read sits outside the MCP mutation gate). With no deviceId yet, reads answer "not
// configured" and only the operator write creates it.
test("reads never create the device identity; only the operator write does", () =>
  withDirs(async ({ workspace, appData }) => {
    const memory = createMemoryStore();
    let deviceId: string | null = null;
    let ensureCalls = 0;
    const services = createChannelWorkspacesServices({
      readDeviceId: async () => deviceId,
      ensureDeviceId: async () => {
        ensureCalls++;
        deviceId ??= "device-created";
        return deviceId;
      },
      store: memory.store,
      listConnectedChannelIds: async () => ["UC_A"],
      validatePath: (candidate) => validateWorkspacePath(candidate, { appDataDir: appData, ...createPathValidationFsAdapter() }),
      realpath: (candidate) => realpath(candidate),
    });

    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: false });
    assert.deepEqual(await services.listWorkspaces(), [{ channelId: "UC_A", path: null, updatedAt: null }]);
    assert.equal(ensureCalls, 0);

    await services.setWorkspace({ channelId: "UC_A", path: workspace });
    assert.equal(ensureCalls, 1);
    assert.deepEqual(await services.getWorkspace({ channelId: "UC_A" }), { configured: true, path: workspace });
  }));
