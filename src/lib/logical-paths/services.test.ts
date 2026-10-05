import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPathValidationFsAdapter } from "@/lib/local-path-validation/adapters/fs";
import { validateWorkspacePath } from "@/lib/local-path-validation/services";
import { isDomainError } from "./contracts";
import { createLogicalPathServices, type LogicalPathStore } from "./services";

// Expected behavior comes from docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md §4
// (AC-FO-01..05, 09, 11), written before this module. It is not derived from the implementation.

function createMemoryStore(initial: Array<{ name: string; audience: "all_agents" | "factory_only"; description?: string }>) {
  const definitions = new Map(
    initial.map((d) => [d.name, { name: d.name, audience: d.audience, description: d.description ?? "", createdAt: new Date("2026-10-05T00:00:00Z") }])
  );
  const values = new Map<string, { path: string; updatedAt: Date }>();
  let setCalls = 0;
  const store: LogicalPathStore = {
    async listDefinitions() {
      return [...definitions.values()];
    },
    async insertDefinition(input) {
      if (definitions.has(input.name)) return false;
      definitions.set(input.name, { ...input, createdAt: new Date("2026-10-05T00:00:00Z") });
      return true;
    },
    async deleteDefinition(name) {
      for (const key of [...values.keys()]) if (key.endsWith(`|${name}`)) values.delete(key);
      return definitions.delete(name);
    },
    async getValue(deviceId, name) {
      return values.get(`${deviceId}|${name}`)?.path ?? null;
    },
    async listValues(deviceId) {
      return [...values.entries()]
        .filter(([key]) => key.startsWith(`${deviceId}|`))
        .map(([key, value]) => ({ name: key.split("|")[1], ...value }));
    },
    async setValue(deviceId, name, value) {
      setCalls++;
      if (value === null) values.delete(`${deviceId}|${name}`);
      else values.set(`${deviceId}|${name}`, { path: value, updatedAt: new Date("2026-10-05T00:00:00Z") });
    },
  };
  return { store, values, setCallCount: () => setCalls };
}

async function withDirs(run: (dirs: { root: string; folderA: string; folderB: string; appData: string; file: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "logical-paths-test-"));
  try {
    const folderA = path.join(root, "folder-a");
    const folderB = path.join(root, "folder-b");
    const appData = path.join(root, "app-data");
    const file = path.join(root, "a-file.txt");
    await mkdir(folderA);
    await mkdir(folderB);
    await mkdir(appData);
    await writeFile(file, "x");
    await run({ root, folderA, folderB, appData, file });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SEED = [
  { name: "factory_shared", audience: "all_agents" as const },
  { name: "developer_exchange", audience: "factory_only" as const },
];

function createServices(appDataDir: string, deviceId: string | null = "device-x", seed = SEED) {
  const memory = createMemoryStore(seed);
  let deviceCreated = false;
  const services = createLogicalPathServices({
    readDeviceId: async () => deviceId,
    ensureDeviceId: async () => {
      deviceCreated = true;
      return deviceId ?? "device-new";
    },
    store: memory.store,
    validatePath: (candidate) => validateWorkspacePath(candidate, { appDataDir, ...createPathValidationFsAdapter() }),
    pathExists: async (candidate) => {
      try {
        return (await createPathValidationFsAdapter().stat(candidate)).isDirectory;
      } catch {
        return false;
      }
    },
  });
  return { services, memory, deviceCreated: () => deviceCreated };
}

async function rejectsWithCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => isDomainError(error) && error.code === code);
}

test("AC-FO-01: a value is stored per device and returned only on that device", () =>
  withDirs(async ({ folderA, folderB, appData }) => {
    const deviceX = createServices(appData, "device-x");
    await deviceX.services.setValue({ name: "factory_shared", path: folderA });
    assert.deepEqual(await deviceX.services.readPath({ name: "factory_shared" }, "factory"), {
      name: "factory_shared",
      path: folderA,
    });

    // The same store seen from another device (a row stored under X is invisible to Y).
    const deviceY = createLogicalPathServices({
      readDeviceId: async () => "device-y",
      ensureDeviceId: async () => "device-y",
      store: deviceX.memory.store,
      validatePath: async () => ({ ok: true }) as never,
      pathExists: async () => true,
    });
    await rejectsWithCode(deviceY.readPath({ name: "factory_shared" }, "factory"), "LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE");
    await deviceY.setValue({ name: "factory_shared", path: folderB });
    assert.equal((await deviceY.readPath({ name: "factory_shared" }, "factory")).path, folderB);
    assert.equal((await deviceX.services.readPath({ name: "factory_shared" }, "factory")).path, folderA);
  }));

test("AC-FO-02: a defined path with no value on this device is an explicit error, never an empty path", () =>
  withDirs(async ({ appData }) => {
    const { services } = createServices(appData);
    await rejectsWithCode(services.readPath({ name: "factory_shared" }, "factory"), "LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE");
    const listed = await services.listReadable("factory");
    assert.deepEqual(
      listed.map((entry) => [entry.name, entry.configured]),
      [
        ["factory_shared", false],
        ["developer_exchange", false],
      ]
    );
    for (const entry of listed) assert.equal("path" in entry, false);
  }));

test("AC-FO-02: clearing removes the value again (explicit error afterwards)", () =>
  withDirs(async ({ folderA, appData }) => {
    const { services } = createServices(appData);
    await services.setValue({ name: "factory_shared", path: folderA });
    assert.deepEqual(await services.setValue({ name: "factory_shared", path: "  " }), { name: "factory_shared", path: null });
    await rejectsWithCode(services.readPath({ name: "factory_shared" }, "factory"), "LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE");
    assert.deepEqual(await services.setValue({ name: "factory_shared", path: null }), { name: "factory_shared", path: null });
  }));

test("AC-FO-03: a third path is just a row; it can be created, given a value, read, and deleted", () =>
  withDirs(async ({ folderA, appData }) => {
    const { services } = createServices(appData);
    await services.createPath({ name: "script_library", audience: "all_agents", description: " Shared scripts " });
    await services.setValue({ name: "script_library", path: folderA });
    assert.equal((await services.readPath({ name: "script_library" }, "channel")).path, folderA);
    const operator = await services.listForOperator();
    assert.deepEqual(
      operator.map((entry) => entry.name),
      ["factory_shared", "developer_exchange", "script_library"]
    );
    assert.equal(operator.find((entry) => entry.name === "script_library")?.description, "Shared scripts");
    await services.deletePath({ name: "script_library" });
    await rejectsWithCode(services.readPath({ name: "script_library" }, "factory"), "LOGICAL_PATH_NOT_FOUND");
  }));

test("AC-FO-04: set-time rejection saves nothing (relative, missing, file, app-data itself, inside it, ancestor of it)", () =>
  withDirs(async ({ root, folderA, appData, file }) => {
    const { services, memory } = createServices(appData);
    await mkdir(path.join(appData, "inner"));
    const rejected = [
      "relative/path",
      path.join(root, "does-not-exist"),
      file,
      appData,
      path.join(appData, "inner"),
      root,
    ];
    for (const candidate of rejected) {
      await rejectsWithCode(services.setValue({ name: "factory_shared", path: candidate }), "LOGICAL_PATH_VALUE_INVALID");
    }
    assert.equal(memory.values.size, 0);
    assert.equal(memory.setCallCount(), 0);
    // A valid sibling is still accepted afterwards.
    await services.setValue({ name: "factory_shared", path: folderA });
    assert.equal(memory.values.size, 1);
  }));

test("AC-FO-04: invalid names are rejected (validation_failed); a duplicate name and an unknown name have their own codes", () =>
  withDirs(async ({ folderA, appData }) => {
    const { services } = createServices(appData);
    for (const name of ["", "A", "1abc", "has space", "UPPER", "a", "x".repeat(65), "dash-name"]) {
      await rejectsWithCode(services.createPath({ name, audience: "all_agents" }), "validation_failed");
    }
    await rejectsWithCode(services.createPath({ name: "factory_shared", audience: "factory_only" }), "LOGICAL_PATH_ALREADY_EXISTS");
    await rejectsWithCode(services.createPath({ name: "other_name", audience: "everyone" }), "validation_failed");
    await rejectsWithCode(services.setValue({ name: "no_such_name", path: folderA }), "LOGICAL_PATH_NOT_FOUND");
    await rejectsWithCode(services.deletePath({ name: "no_such_name" }), "LOGICAL_PATH_NOT_FOUND");
    // The duplicate attempt did not change the existing definition's audience.
    const list = await services.listForOperator();
    assert.equal(list.find((entry) => entry.name === "factory_shared")?.audience, "all_agents");
  }));

test("AC-FO-05: a channel scope sees only all_agents paths; a hidden and an unknown name fail identically", () =>
  withDirs(async ({ folderA, folderB, appData }) => {
    const { services } = createServices(appData);
    await services.setValue({ name: "factory_shared", path: folderA });
    await services.setValue({ name: "developer_exchange", path: folderB });

    assert.deepEqual(await services.readPath({ name: "factory_shared" }, "channel"), { name: "factory_shared", path: folderA });
    assert.deepEqual(
      (await services.listReadable("channel")).map((entry) => entry.name),
      ["factory_shared"]
    );

    const captured: unknown[] = [];
    for (const name of ["developer_exchange", "no_such_name"]) {
      await assert.rejects(services.readPath({ name }, "channel"), (error) => {
        captured.push(isDomainError(error) ? { code: error.code, message: error.message } : error);
        return true;
      });
    }
    assert.equal((captured[0] as { code: string }).code, "LOGICAL_PATH_NOT_FOUND");
    assert.equal((captured[1] as { code: string }).code, "LOGICAL_PATH_NOT_FOUND");
    assert.equal((captured[0] as { message: string }).message, (captured[1] as { message: string }).message);

    // The factory scope sees both.
    assert.equal((await services.readPath({ name: "developer_exchange" }, "factory")).path, folderB);
    assert.equal((await services.listReadable("factory")).length, 2);
  }));

test("AC-FO-09: the read input is strict (an extra path field is rejected) and reads never write", () =>
  withDirs(async ({ folderA, appData }) => {
    const { services, memory } = createServices(appData);
    await services.setValue({ name: "factory_shared", path: folderA });
    const writesBefore = memory.setCallCount();
    await rejectsWithCode(
      services.readPath({ name: "factory_shared", path: "/etc" } as unknown, "factory"),
      "validation_failed"
    );
    await services.readPath({ name: "factory_shared" }, "factory");
    await services.listReadable("factory");
    await services.listForOperator();
    assert.equal(memory.setCallCount(), writesBefore);
    assert.equal(memory.values.size, 1);
  }));

test("AC-FO-11: a read never touches the path and never creates the device identity", () =>
  withDirs(async ({ folderA, appData }) => {
    const { services, deviceCreated } = createServices(appData, "device-x");
    await services.setValue({ name: "factory_shared", path: folderA });
    const createdByWrite = deviceCreated();
    assert.equal(createdByWrite, true);

    // The directory is deleted afterwards: the stored string is still returned unchanged.
    await rm(folderA, { recursive: true, force: true });
    assert.equal((await services.readPath({ name: "factory_shared" }, "factory")).path, folderA);

    // With no device identity at all, reads answer "not configured" and do not create one.
    const fresh = createServices(appData, null);
    await rejectsWithCode(fresh.services.readPath({ name: "factory_shared" }, "factory"), "LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE");
    await fresh.services.listReadable("factory");
    await fresh.services.listForOperator();
    assert.equal(fresh.deviceCreated(), false);
  }));

test("review: a rejected value and a clear never create the device identity; only a validated value does", () =>
  withDirs(async ({ folderA, appData }) => {
    const fresh = createServices(appData, null);
    await rejectsWithCode(fresh.services.setValue({ name: "factory_shared", path: "relative/path" }), "LOGICAL_PATH_VALUE_INVALID");
    await fresh.services.setValue({ name: "factory_shared", path: null });
    assert.equal(fresh.deviceCreated(), false);
    assert.equal(fresh.memory.setCallCount(), 0);

    await fresh.services.setValue({ name: "factory_shared", path: folderA });
    assert.equal(fresh.deviceCreated(), true);
    assert.equal(fresh.memory.values.size, 1);
  }));

test("operator listing reports exists / missing / unset for this device", () =>
  withDirs(async ({ folderA, folderB, appData }) => {
    const { services } = createServices(appData);
    await services.setValue({ name: "factory_shared", path: folderA });
    await services.setValue({ name: "developer_exchange", path: folderB });
    await rm(folderB, { recursive: true, force: true });
    await services.createPath({ name: "unset_one", audience: "factory_only" });

    const byName = new Map((await services.listForOperator()).map((entry) => [entry.name, entry]));
    assert.equal(byName.get("factory_shared")?.status, "exists");
    assert.equal(byName.get("developer_exchange")?.status, "missing");
    assert.equal(byName.get("developer_exchange")?.path, folderB);
    assert.equal(byName.get("unset_one")?.status, null);
    assert.equal(byName.get("unset_one")?.path, null);
  }));
