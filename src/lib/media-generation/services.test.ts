import assert from "node:assert/strict";
import test from "node:test";
import type { RunpodApiClient, RunpodS3Client, RunpodS3Config } from "@/lib/media-gateway";
import { DEFAULT_MEDIA_SETTINGS, isDomainError } from "./contracts";
import { createKeyFile, type KeyFileAccess } from "./key-file";
import { createMediaGenerationServices, type MediaGenerationStore, type StoredCredentialsRow } from "./services";

// Expected behaviour is stated in docs/roadmap/plans/PHASE_14_PLAN.md §4 (AC-P14-01, -02, -19,
// -21) and §2.9, written before this module. Nothing here is read back from the implementation.

const RUNPOD_KEY = "rpa_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function memoryStore() {
  let credentials: StoredCredentialsRow | null = null;
  let settingsJson: string | null = null;
  let gatewayEnabled = true;
  const store: MediaGenerationStore = {
    async getCredentials() {
      return credentials;
    },
    async upsertCredentials(input) {
      credentials = { ...input, verifiedAt: null, updatedAt: new Date("2026-10-05T12:00:00Z") };
    },
    async setCredentialsVerifiedAt(at) {
      if (credentials) credentials = { ...credentials, verifiedAt: at };
    },
    async clearCredentials() {
      credentials = null;
    },
    async getSettingsJson() {
      return settingsJson;
    },
    async setSettingsJson(json) {
      settingsJson = json;
    },
    async getGatewayEnabled() {
      return gatewayEnabled;
    },
    async setGatewayEnabled(enabled) {
      gatewayEnabled = enabled;
    },
  };
  return { store, row: () => credentials, settingsJson: () => settingsJson };
}

function memoryKeyFile(initial: string | null = null) {
  let content = initial;
  const access: KeyFileAccess = {
    async read() {
      return content;
    },
    async write(next) {
      content = JSON.stringify(next);
    },
    randomBytes: (size) => Buffer.alloc(size, 3),
  };
  return { keyFile: createKeyFile(access), content: () => content, drop: () => (content = null) };
}

type FakeRunpod = {
  client: RunpodApiClient;
  calls: string[];
  keysSeen: string[];
};

function fakeRunpod(options: { verifyFails?: boolean } = {}): { factory: (apiKey: string) => RunpodApiClient } & FakeRunpod {
  const calls: string[] = [];
  const keysSeen: string[] = [];
  const client = {
    async verifyKey() {
      calls.push("verifyKey");
      if (options.verifyFails) throw new Error("RunPod rejected the API key (HTTP 401).");
      return { ok: true as const };
    },
    async listGpuTypes() {
      calls.push("listGpuTypes");
      return [
        { id: "NVIDIA GeForce RTX 4090", displayName: "RTX 4090", memoryInGb: 24, secureCloud: true, communityCloud: true, onDemandPricePerHr: 0.69, spotPricePerHr: 0.34, estimatedAvailability: "HIGH", dataCenters: [] },
      ];
    },
    async listDataCenters() {
      calls.push("listDataCenters");
      return [
        { id: "EU-RO-1", countryCode: "RO", region: "EU" },
        { id: "US-TX-3", countryCode: "US", region: "US" },
      ];
    },
    async listNetworkVolumes() {
      calls.push("listNetworkVolumes");
      return [{ id: "vol-eu", name: "models", dataCenterId: "EU-RO-1", sizeGb: 150, usedSizeGb: 10, createdAt: null }];
    },
    async getNetworkVolume(id: string) {
      calls.push(`getNetworkVolume:${id}`);
      if (id === "vol-eu") return { id, name: "models", dataCenterId: "EU-RO-1", sizeGb: 150, usedSizeGb: 10, createdAt: null };
      if (id === "vol-us") return { id, name: "models-us", dataCenterId: "US-TX-3", sizeGb: 50, usedSizeGb: 0, createdAt: null };
      return null;
    },
    async createNetworkVolume(input: { name: string; dataCenterId: string; sizeGb: number }) {
      calls.push("createNetworkVolume");
      return { id: "vol-new", name: input.name, dataCenterId: input.dataCenterId, sizeGb: input.sizeGb, usedSizeGb: 0, createdAt: null };
    },
    async listPods() {
      calls.push("listPods");
      return [];
    },
    async getPod() {
      return null;
    },
    async createPod() {
      throw new Error("not in this test");
    },
    async terminatePod() {
      return { terminated: true as const, alreadyGone: false };
    },
    async listTemplates() {
      return [];
    },
  } as unknown as RunpodApiClient;
  return {
    client,
    calls,
    keysSeen,
    factory: (apiKey: string) => {
      keysSeen.push(apiKey);
      return client;
    },
  };
}

function fakeS3(options: { fails?: boolean } = {}) {
  const configs: RunpodS3Config[] = [];
  const client = {
    async testAccess() {
      if (options.fails) throw new Error("RunPod S3 rejected the key pair (HTTP 403).");
      return { ok: true as const };
    },
  } as unknown as RunpodS3Client;
  return {
    configs,
    factory: (config: RunpodS3Config) => {
      configs.push(config);
      return client;
    },
  };
}

function fixture(opts: { keyFileContent?: string | null; runpod?: ReturnType<typeof fakeRunpod>; s3?: ReturnType<typeof fakeS3>; activeVolumeHolder?: () => Promise<string | null> } = {}) {
  const mem = memoryStore();
  const key = memoryKeyFile(opts.keyFileContent ?? null);
  const runpod = opts.runpod ?? fakeRunpod();
  const s3 = opts.s3 ?? fakeS3();
  const services = createMediaGenerationServices({
    store: mem.store,
    keyFile: key.keyFile,
    gateway: { createRunpodClient: runpod.factory, createS3Client: s3.factory },
    clock: { now: () => new Date("2026-10-05T12:34:56Z") },
    ...(opts.activeVolumeHolder ? { activeVolumeHolder: opts.activeVolumeHolder } : {}),
  });
  return { services, mem, key, runpod, s3 };
}

// -- AC-P14-01 --------------------------------------------------------------------------------

test("AC-P14-01: with nothing configured the overview is 'not configured', defaults apply, and no RunPod call is made", async () => {
  const { services, runpod } = fixture();
  const overview = await services.getOverview();
  assert.deepEqual(overview.credentials, { configured: false, reason: "no_credentials" });
  assert.deepEqual(overview.settings, DEFAULT_MEDIA_SETTINGS);
  assert.equal(overview.gatewayEnabled, true);
  assert.equal(overview.ready, false);
  assert.deepEqual(overview.missing, ["RunPod credentials", "datacenter", "GPU type", "network volume", "pod template"]);
  assert.deepEqual(runpod.calls, []);
  assert.deepEqual(runpod.keysSeen, []);
});

test("AC-P14-01: catalog reads without credentials fail with media_generation_not_configured and never touch the gateway", async () => {
  const { services, runpod } = fixture();
  for (const call of [() => services.listGpuTypes(), () => services.listDataCenters(), () => services.listNetworkVolumes(), () => services.listPods(), () => services.testCredentials()]) {
    await assert.rejects(call(), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  }
  assert.deepEqual(runpod.keysSeen, []);
});

// -- AC-P14-02 / AC-P14-21 ---------------------------------------------------------------------

test("AC-P14-02: saving credentials stores only ciphertext; the status and the stored row never contain the key", async () => {
  const { services, mem } = fixture();
  const status = await services.setCredentials({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_abc", s3SecretAccessKey: "rps_secret_value" });
  assert.deepEqual(status, {
    configured: true,
    runpodKeyPrefix: "rpa_ABCD…",
    s3AccessKeyId: "user_abc",
    verifiedAt: null,
    updatedAt: "2026-10-05T12:00:00Z".replace("Z", ".000Z"),
  });
  const row = mem.row();
  assert.ok(row);
  const serialized = JSON.stringify(row) + JSON.stringify(status);
  assert.ok(!serialized.includes(RUNPOD_KEY), "the RunPod key must not appear anywhere");
  assert.ok(!serialized.includes("rps_secret_value"), "the S3 secret must not appear anywhere");
  assert.notEqual(row.ciphertext, "");
});

test("AC-P14-02: the decrypted key reaches only the gateway factory, at call time", async () => {
  const { services, runpod } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.listDataCenters();
  assert.deepEqual(runpod.keysSeen, [RUNPOD_KEY]);
  assert.deepEqual(runpod.calls, ["listDataCenters"]);
});

test("AC-P14-21: the key file is created on the first save, not by reads; a later clear leaves the file", async () => {
  const { services, key } = fixture();
  await services.getOverview();
  assert.equal(key.content(), null);
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  assert.ok(key.content());
  assert.deepEqual(await services.clearCredentials(), { configured: false, reason: "no_credentials" });
  assert.ok(key.content(), "clearing credentials never deletes the device key");
});

test("AC-P14-21: a stored row without the key file reads as not configured (key_file_missing); no decryption, no call", async () => {
  const { services, key, runpod } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  key.drop();
  assert.deepEqual(await services.getCredentialsStatus(), { configured: false, reason: "key_file_missing" });
  await assert.rejects(services.listDataCenters(), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  assert.deepEqual(runpod.keysSeen, []);
});

test("a row encrypted under a different device key fails closed as not configured", async () => {
  const first = fixture();
  await first.services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  const row = first.mem.row();
  assert.ok(row);
  // Same row, a different key file (as after copying playlist-manager.db to another machine).
  const other = fixture({ keyFileContent: JSON.stringify({ version: 1, key: Buffer.alloc(32, 7).toString("base64") }) });
  await other.mem.store.upsertCredentials({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, runpodKeyPrefix: row.runpodKeyPrefix, s3AccessKeyId: null });
  await assert.rejects(other.services.listDataCenters(), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
});

test("credential input validation: short key, S3 id without secret, extra field", async () => {
  const { services } = fixture();
  await assert.rejects(services.setCredentials({ runpodApiKey: "short" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(services.setCredentials({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_x" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(services.setCredentials({ runpodApiKey: RUNPOD_KEY, extra: 1 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
});

// -- testCredentials ---------------------------------------------------------------------------

test("testCredentials: RunPod ok + S3 skipped (no pair) stamps verifiedAt; a failing probe is reported, not thrown, and leaves verifiedAt null", async () => {
  const ok = fixture();
  await ok.services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  assert.deepEqual(await ok.services.testCredentials(), { runpod: { ok: true }, s3: { skipped: true, reason: "no S3 key pair is stored" }, verifiedAt: "2026-10-05T12:34:56.000Z" });
  const status = await ok.services.getCredentialsStatus();
  assert.ok(status.configured && status.verifiedAt === "2026-10-05T12:34:56.000Z");

  const bad = fixture({ runpod: fakeRunpod({ verifyFails: true }) });
  await bad.services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  const result = await bad.services.testCredentials();
  assert.equal(result.runpod.ok, false);
  assert.equal(result.verifiedAt, null);
});

test("testCredentials: the S3 probe uses the stored pair with the chosen datacenter and volume; a 403 is reported", async () => {
  const s3 = fakeS3({ fails: true });
  const { services } = fixture({ s3 });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_abc", s3SecretAccessKey: "rps_secret" });
  await services.updateSettings({ datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" });
  const result = await services.testCredentials();
  assert.deepEqual(s3.configs, [{ datacenterId: "EU-RO-1", volumeId: "vol-eu", accessKeyId: "user_abc", secretAccessKey: "rps_secret" }]);
  assert.equal(result.runpod.ok, true);
  assert.ok("ok" in result.s3 && result.s3.ok === false);
  assert.equal(result.verifiedAt, null);
});

// -- AC-P14-19 ---------------------------------------------------------------------------------

test("AC-P14-19: numeric bounds -- watchIntervalSeconds >= 15, idleMinutes >= 1, maxUsdPerDay > 0; the stored value is unchanged on rejection", async () => {
  const { services, mem } = fixture();
  for (const bad of [{ watchIntervalSeconds: 14 }, { idleMinutes: 0 }, { maxUsdPerDay: 0 }, { defaultMaxMinutes: 0 }, { cloudType: "SPOT" }, { unknown: 1 }]) {
    await assert.rejects(services.updateSettings(bad), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  }
  assert.equal(mem.settingsJson(), null);
  const saved = await services.updateSettings({ watchIntervalSeconds: 15, idleMinutes: 1, maxUsdPerDay: 0.5, defaultMaxMinutes: 30 });
  assert.equal(saved.watchIntervalSeconds, 15);
  assert.equal(saved.idleMinutes, 1);
  assert.equal(saved.maxUsdPerDay, 0.5);
  assert.equal(saved.defaultMaxMinutes, 30);
  assert.equal(saved.cloudType, "SECURE");
  assert.deepEqual(await services.getSettings(), saved);
});

test("AC-P14-19: datacenter and GPU must come from the live catalog; both need credentials", async () => {
  const { services, runpod } = fixture();
  await assert.rejects(services.updateSettings({ gpuTypeId: "NVIDIA GeForce RTX 4090" }), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await assert.rejects(services.updateSettings({ datacenterId: "XX-YY-9" }), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid");
  await assert.rejects(services.updateSettings({ gpuTypeId: "NVIDIA H200" }), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid");
  await assert.rejects(services.updateSettings({ datacenterId: "eu-ro-1" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  const saved = await services.updateSettings({ datacenterId: "EU-RO-1", gpuTypeId: "NVIDIA GeForce RTX 4090" });
  assert.equal(saved.datacenterId, "EU-RO-1");
  assert.equal(saved.gpuTypeId, "NVIDIA GeForce RTX 4090");
  assert.ok(runpod.calls.includes("listDataCenters") && runpod.calls.includes("listGpuTypes"));
});

test("AC-P14-19: the network volume must exist and sit in the chosen datacenter", async () => {
  const { services } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1" });
  await assert.rejects(services.updateSettings({ networkVolumeId: "vol-missing" }), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid");
  await assert.rejects(
    services.updateSettings({ networkVolumeId: "vol-us" }),
    (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid" && (e.details as { volumeDatacenterId?: string }).volumeDatacenterId === "US-TX-3"
  );
  const saved = await services.updateSettings({ networkVolumeId: "vol-eu" });
  assert.equal(saved.networkVolumeId, "vol-eu");
  // Moving the datacenter away from the volume's one is rejected too.
  await assert.rejects(services.updateSettings({ datacenterId: "US-TX-3" }), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid");
  // Clearing the volume needs no catalog call.
  const cleared = await services.updateSettings({ networkVolumeId: null });
  assert.equal(cleared.networkVolumeId, null);
});

test("overview becomes ready once credentials, datacenter, GPU, volume and template are set; the gateway toggle is part of it", async () => {
  const { services } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1", gpuTypeId: "NVIDIA GeForce RTX 4090", networkVolumeId: "vol-eu", templateId: "tpl1" });
  assert.equal((await services.getOverview()).ready, true);
  await services.setGatewayEnabled(false);
  const overview = await services.getOverview();
  assert.equal(overview.ready, false);
  assert.deepEqual(overview.missing, ["media gateway toggle (off)"]);
});

test("a corrupt settings blob falls back to defaults instead of breaking the feature", async () => {
  const { services, mem } = fixture();
  await mem.store.setSettingsJson("{not json");
  assert.deepEqual(await services.getSettings(), DEFAULT_MEDIA_SETTINGS);
  await mem.store.setSettingsJson(JSON.stringify({ watchIntervalSeconds: 1 }));
  assert.deepEqual(await services.getSettings(), DEFAULT_MEDIA_SETTINGS);
});

test("createNetworkVolume validates its input and passes name/datacenter/size through", async () => {
  const { services, runpod } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await assert.rejects(services.createNetworkVolume({ name: "x", datacenterId: "EU-RO-1", sizeGb: 5 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  const volume = await services.createNetworkVolume({ name: "models", datacenterId: "EU-RO-1", sizeGb: 150 });
  assert.equal(volume.id, "vol-new");
  assert.equal(volume.sizeGb, 150);
  assert.ok(runpod.calls.includes("createNetworkVolume"));
});

test("s3() needs the pair, the datacenter and the volume", async () => {
  const { services } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await assert.rejects(services.s3(), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "u", s3SecretAccessKey: "s" });
  await assert.rejects(services.s3(), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  await services.updateSettings({ datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" });
  assert.ok(await services.s3());
});

test("review 2: changing the cloud type re-prices the chosen GPU from the catalog", async () => {
  const runpod = fakeRunpod();
  const priced = runpod.client as unknown as { listGpuTypes: (o?: { cloud?: string }) => Promise<unknown[]> };
  priced.listGpuTypes = async (o) => [
    { id: "NVIDIA GeForce RTX 4090", displayName: "RTX 4090", memoryInGb: 24, secureCloud: true, communityCloud: true, onDemandPricePerHr: o?.cloud === "COMMUNITY" ? 0.34 : 0.69, spotPricePerHr: null, estimatedAvailability: "HIGH", dataCenters: [] },
  ];
  const { services } = fixture({ runpod });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  const secure = await services.updateSettings({ gpuTypeId: "NVIDIA GeForce RTX 4090" });
  assert.equal(secure.gpuOnDemandPricePerHr, 0.69);
  const community = await services.updateSettings({ cloudType: "COMMUNITY" });
  assert.equal(community.gpuOnDemandPricePerHr, 0.34);
  const cleared = await services.updateSettings({ gpuTypeId: null });
  assert.equal(cleared.gpuOnDemandPricePerHr, null);
});

test("review 3: a three-letter datacenter region (CA-MTL-1) passes the settings validation", async () => {
  const runpod = fakeRunpod();
  (runpod.client as unknown as { listDataCenters: () => Promise<unknown[]> }).listDataCenters = async () => [{ id: "CA-MTL-1", countryCode: "CA", region: "NA" }];
  const { services } = fixture({ runpod });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  assert.equal((await services.updateSettings({ datacenterId: "CA-MTL-1" })).datacenterId, "CA-MTL-1");
});

// -- review round 9 (2026-10-05) ------------------------------------------------------------------

test("review 9: stored settings with one bad key keep every valid key (the spend cap above all) -- only the offending key falls back to its default", async () => {
  const f = fixture();
  await f.mem.store.setSettingsJson(JSON.stringify({ maxUsdPerDay: 2, idleMinutes: "abc", datacenterId: "EU-RO-1", futureKey: true }));
  const settings = await f.services.getSettings();
  assert.equal(settings.maxUsdPerDay, 2, "the operator's cap survives");
  assert.equal(settings.datacenterId, "EU-RO-1");
  assert.equal(settings.idleMinutes, DEFAULT_MEDIA_SETTINGS.idleMinutes, "only the invalid key is defaulted");
  // Malformed JSON altogether: defaults (nothing to salvage).
  await f.mem.store.setSettingsJson("{not json");
  assert.equal((await f.services.getSettings()).maxUsdPerDay, DEFAULT_MEDIA_SETTINGS.maxUsdPerDay);
});

test("review 9: the media gateway cannot be disabled while a session or pull holds the volume (the pod could never be terminated); enabling is always allowed", async () => {
  let holder: string | null = "session:s1";
  const f = fixture({ activeVolumeHolder: async () => holder });
  await assert.rejects(f.services.setGatewayEnabled(false), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /session is open/.test(e.message));
  assert.equal(await f.services.getGatewayEnabled(), true);
  await f.services.setGatewayEnabled(true);
  holder = "pull:p1";
  await assert.rejects(f.services.setGatewayEnabled(false), (e: unknown) => isDomainError(e) && /model pull is running/.test((e as Error).message));
  holder = null;
  await f.services.setGatewayEnabled(false);
  assert.equal(await f.services.getGatewayEnabled(), false);
});
