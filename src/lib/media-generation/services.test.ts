import assert from "node:assert/strict";
import test from "node:test";
import { createRunpodApiClient, type RunpodApiClient, type RunpodS3Client, type RunpodS3Config } from "@/lib/media-gateway";
import { DEFAULT_MEDIA_SETTINGS, isDomainError } from "./contracts";
import { createKeyFile, type KeyFileAccess } from "./key-file";
import { DomainError } from "@/lib/shared-domain";
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
    async remove() {
      content = null;
    },
  };
  return { keyFile: createKeyFile(access), content: () => content, drop: () => (content = null), corrupt: () => (content = "{not json") };
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
    async resizeNetworkVolume(id: string, sizeGb: number) {
      calls.push(`resizeNetworkVolume:${id}:${sizeGb}`);
      return { id, name: "models", dataCenterId: "EU-RO-1", sizeGb, usedSizeGb: 10, createdAt: null };
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
      return [{ id: "tpl1", name: "comfy", raw: {} }]; // the account's one pod template (validated on save since review round 12)
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

function fixture(opts: { keyFileContent?: string | null; runpod?: ReturnType<typeof fakeRunpod>; s3?: ReturnType<typeof fakeS3>; activeVolumeHolder?: () => Promise<string | null>; volumeLock?: import("./volume-lock").VolumeLock } = {}) {
  const mem = memoryStore();
  const key = memoryKeyFile(opts.keyFileContent ?? null);
  let now = new Date("2026-10-05T12:34:56Z");
  const runpod = opts.runpod ?? fakeRunpod();
  const s3 = opts.s3 ?? fakeS3();
  const services = createMediaGenerationServices({
    store: mem.store,
    keyFile: key.keyFile,
    gateway: { createRunpodClient: runpod.factory, createS3Client: s3.factory },
    clock: { now: () => now },
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms); // the terminate passthrough's confirm poll advances the fake clock
    },
    ...(opts.activeVolumeHolder ? { activeVolumeHolder: opts.activeVolumeHolder } : {}),
    ...(opts.volumeLock ? { volumeLock: opts.volumeLock } : {}),
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

test("overview becomes ready once credentials (RunPod key AND the S3 pair), datacenter, GPU, volume and template are set; the gateway toggle is part of it", async () => {
  const { services } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1", gpuTypeId: "NVIDIA GeForce RTX 4090", networkVolumeId: "vol-eu", templateId: "tpl1" });
  // Review round 13: outputs travel over S3 only -- without the key pair a job could be generated and never received.
  assert.deepEqual((await services.getOverview()).missing, ["S3 key pair (RunPod → Settings → S3 API keys)"]);
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_1", s3SecretAccessKey: "rps_secret" });
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

// Owner request (Telegram 2026-10-06) + RunPod's update endpoint: a network volume can only grow. vol-eu is 150 GB in the fake.
test("resizeNetworkVolume grows a volume to a larger size", async () => {
  const { services, runpod } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  const volume = await services.resizeNetworkVolume({ volumeId: "vol-eu", sizeGb: 151 });
  assert.equal(volume.sizeGb, 151);
  assert.ok(runpod.calls.includes("getNetworkVolume:vol-eu"));
  assert.ok(runpod.calls.includes("resizeNetworkVolume:vol-eu:151"));
});

test("resizeNetworkVolume refuses the same or a smaller size, and an unknown volume, without calling RunPod's update", async () => {
  const { services, runpod } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await assert.rejects(services.resizeNetworkVolume({ volumeId: "vol-eu", sizeGb: 150 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(services.resizeNetworkVolume({ volumeId: "vol-eu", sizeGb: 100 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(services.resizeNetworkVolume({ volumeId: "vol-missing", sizeGb: 200 }), (e: unknown) => isDomainError(e) && e.code === "not_found");
  // Schema bounds: RunPod's 10 GB floor and the app's 4000 GB ceiling; a non-integer size; a missing id.
  await assert.rejects(services.resizeNetworkVolume({ volumeId: "vol-eu", sizeGb: 9 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(services.resizeNetworkVolume({ volumeId: "vol-eu", sizeGb: 4001 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(services.resizeNetworkVolume({ volumeId: "vol-eu", sizeGb: 200.5 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(services.resizeNetworkVolume({ sizeGb: 200 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.ok(!runpod.calls.some((c) => c.startsWith("resizeNetworkVolume")));
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

// -- review round 10 (2026-10-05) -----------------------------------------------------------------

test("review 10: changing the datacenter re-validates and re-prices the kept GPU against the live catalog (AC-P14-19) -- a GPU absent there is refused at settings time, a different price is captured", async () => {
  const runpod = fakeRunpod();
  let gpus: Array<Record<string, unknown>> = [{ id: "NVIDIA GeForce RTX 4090", displayName: "RTX 4090", memoryInGb: 24, secureCloud: true, communityCloud: true, onDemandPricePerHr: 0.69, spotPricePerHr: null, estimatedAvailability: "HIGH", dataCenters: [] }];
  (runpod.client as unknown as { listGpuTypes: () => Promise<unknown[]> }).listGpuTypes = async () => gpus;
  const { services } = fixture({ runpod });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1", gpuTypeId: "NVIDIA GeForce RTX 4090" });
  // The catalog for the new datacenter has no 4090: refused, settings unchanged.
  gpus = [];
  await assert.rejects(services.updateSettings({ datacenterId: "US-TX-3" }), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid" && /not in RunPod's catalog/.test(e.message));
  assert.equal((await services.getSettings()).datacenterId, "EU-RO-1");
  // The catalog prices it differently there: the saved price follows.
  gpus = [{ id: "NVIDIA GeForce RTX 4090", displayName: "RTX 4090", memoryInGb: 24, secureCloud: true, communityCloud: true, onDemandPricePerHr: 0.59, spotPricePerHr: null, estimatedAvailability: "HIGH", dataCenters: [] }];
  const moved = await services.updateSettings({ datacenterId: "US-TX-3" });
  assert.equal(moved.datacenterId, "US-TX-3");
  assert.equal(moved.gpuOnDemandPricePerHr, 0.59);
});

test("review 11: a GPU the catalog does not offer in the chosen datacenter is refused at settings time (AC-P14-19), not by a failed createPod at approve", async () => {
  const runpod = fakeRunpod();
  (runpod.client as unknown as { listGpuTypes: () => Promise<unknown[]> }).listGpuTypes = async () => [
    { id: "NVIDIA GeForce RTX 4090", displayName: "RTX 4090", memoryInGb: 24, secureCloud: true, communityCloud: true, onDemandPricePerHr: 0.69, spotPricePerHr: null, estimatedAvailability: "HIGH", dataCenters: [{ id: "US-TX-3", countryCode: "US", estimatedAvailability: "HIGH" }] },
  ];
  const { services } = fixture({ runpod });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await assert.rejects(services.updateSettings({ datacenterId: "EU-RO-1", gpuTypeId: "NVIDIA GeForce RTX 4090" }), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid" && /not offered in datacenter EU-RO-1/.test(e.message));
  const ok = await services.updateSettings({ datacenterId: "US-TX-3", gpuTypeId: "NVIDIA GeForce RTX 4090" });
  assert.equal(ok.gpuOnDemandPricePerHr, 0.69);
});

test("review 12: a pod template id is validated against the account's templates when it changes (like the datacenter, GPU and volume)", async () => {
  const runpod = fakeRunpod();
  (runpod.client as unknown as { listTemplates: () => Promise<unknown[]> }).listTemplates = async () => [{ id: "tpl-real", name: "comfy", raw: {} }];
  const { services } = fixture({ runpod });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await assert.rejects(services.updateSettings({ templateId: "tpl-typo" }), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid" && /not in your RunPod account/.test(e.message));
  assert.equal((await services.updateSettings({ templateId: "tpl-real" })).templateId, "tpl-real");
});

test("review 13: an operator pod that mounts the configured network volume takes the same volume lock as sessions and pulls (refused while held; released when the pod is terminated)", async () => {
  const { createMemoryVolumeLockStore, createVolumeLock } = await import("./volume-lock");
  const runpod = fakeRunpod();
  const pods = new Map<string, { id: string; name: string; status: string }>();
  const client = runpod.client as unknown as Record<string, unknown>;
  client.createPod = async (input: { name: string }) => {
    const pod = { id: `p-${pods.size + 1}`, name: input.name, status: "RUNNING", costPerHr: 0.08, dataCenterId: "EU-RO-1", gpuTypeId: null, gpuCount: 0, networkVolumeIds: [], ports: null, env: {}, createdAt: null, startedAt: null, raw: {} };
    pods.set(pod.id, pod);
    return pod;
  };
  client.getPod = async (id: string) => pods.get(id) ?? null;
  client.terminatePod = async (id: string) => ({ terminated: true, alreadyGone: !pods.delete(id) });
  const store = createMemoryVolumeLockStore();
  const volumeLock = createVolumeLock({ store, isHolderActive: async () => true });
  const { services } = fixture({ runpod, volumeLock });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" });
  // A pod without the volume: no lock involved.
  await services.createPod({ name: "ytm-scratch", image: "python:3.12-slim", cpu: { id: "cpu3c", vcpuCount: 2 }, cloud: "SECURE" });
  assert.equal(store.current(), null);
  // A pod mounting the configured volume: takes `pod:<name>`; a second writer is refused; terminating it releases.
  const pulling = await services.createPod({ name: "ytm-models-pull", image: "python:3.12-slim", cpu: { id: "cpu3c", vcpuCount: 2 }, cloud: "SECURE", mounts: { network: [{ volumeId: "vol-eu", path: "/workspace" }] } });
  assert.equal(store.current(), "pod:ytm-models-pull");
  await assert.rejects(volumeLock.acquire("session:s1"), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /operator pod \(ytm-models-pull\)/.test(e.message));
  await services.terminatePod(pulling.id);
  assert.equal(store.current(), null);
  // A createPod that fails releases the lock it took.
  client.createPod = async () => {
    throw new Error("no capacity");
  };
  await assert.rejects(services.createPod({ name: "ytm-models-pull-2", image: "python:3.12-slim", cpu: { id: "cpu3c", vcpuCount: 2 }, cloud: "SECURE", mounts: { network: [{ volumeId: "vol-eu", path: "/workspace" }] } }));
  assert.equal(store.current(), null);
});

// -- review round 14 (2026-10-05) -----------------------------------------------------------------

test("review 14: the credentials cannot be changed or cleared, and the volume/datacenter cannot be switched, while a session, pull or operator pod holds the volume (the only path able to terminate it would vanish)", async () => {
  let holder: string | null = "session:s1";
  const f = fixture({ activeVolumeHolder: async () => holder });
  await assert.rejects(f.services.setCredentials({ runpodApiKey: RUNPOD_KEY }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /Cannot change the RunPod credentials while a generation session is open/.test(e.message));
  await assert.rejects(f.services.clearCredentials(), (e: unknown) => isDomainError(e) && /Cannot clear the RunPod credentials/.test((e as Error).message));
  holder = null;
  await f.services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await f.services.updateSettings({ datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" });
  holder = "pull:p1";
  await assert.rejects(f.services.updateSettings({ networkVolumeId: "vol-us", datacenterId: "US-TX-3" }), (e: unknown) => isDomainError(e) && /Cannot change the network volume or datacenter while a model pull is running/.test((e as Error).message));
  // Limits and the GPU only affect future sessions: still editable.
  assert.equal((await f.services.updateSettings({ idleMinutes: 3 })).idleMinutes, 3);
  assert.equal((await f.services.updateSettings({ networkVolumeId: "vol-eu" })).networkVolumeId, "vol-eu", "re-saving the same volume is not a change");
});

test("review 15: the operator terminate passthrough releases the pod's volume lock only once RunPod confirms the pod is gone", async () => {
  const { createMemoryVolumeLockStore, createVolumeLock } = await import("./volume-lock");
  const runpod = fakeRunpod();
  const client = runpod.client as unknown as Record<string, unknown>;
  let status: string | null = "RUNNING";
  client.createPod = async (input: { name: string }) => ({ id: "p-1", name: input.name, status: "RUNNING", costPerHr: 0.08, dataCenterId: "EU-RO-1", gpuTypeId: null, gpuCount: 0, networkVolumeIds: [], ports: null, env: {}, createdAt: null, startedAt: null, raw: {} });
  client.getPod = async (id: string) => (status ? { id, name: "ytm-models-pull", status } : null);
  client.terminatePod = async () => ({ terminated: true, alreadyGone: false }); // the container lingers
  const store = createMemoryVolumeLockStore();
  const volumeLock = createVolumeLock({ store, isHolderActive: async () => true });
  const { services } = fixture({ runpod, volumeLock });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" });
  await services.createPod({ name: "ytm-models-pull", image: "python:3.12-slim", cpu: { id: "cpu3c", vcpuCount: 2 }, cloud: "SECURE", mounts: { network: [{ volumeId: "vol-eu", path: "/workspace" }] } });
  assert.equal(store.current(), "pod:ytm-models-pull");
  const unconfirmed = await services.terminatePod("p-1");
  assert.equal(unconfirmed.confirmed, false);
  assert.equal(store.current(), "pod:ytm-models-pull", "still held while the container tears down");
  status = null;
  const confirmed = await services.terminatePod("p-1");
  assert.equal(confirmed.confirmed, true);
  assert.equal(store.current(), null);
});

// -- review round 16 (2026-10-05) -----------------------------------------------------------------

test("review 16: an unreadable key file is REPORTED (key_file_invalid), never thrown out of the overview; Clear then removes the row AND the unreadable key file so a fresh key is created on the next save (a readable key file is kept, AC-P14-21)", async () => {
  const f = fixture();
  await f.services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  f.key.corrupt();
  const status = await f.services.getCredentialsStatus();
  assert.deepEqual(status, { configured: false, reason: "key_file_invalid" });
  assert.equal((await f.services.getOverview()).credentials.configured, false, "the card can still render");
  await f.services.clearCredentials();
  assert.equal(f.key.content(), null, "the corrupt key file is gone");
  assert.deepEqual(await f.services.getCredentialsStatus(), { configured: false, reason: "no_credentials" });
  const again = await f.services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  assert.equal(again.configured, true);
  assert.ok(f.key.content(), "a fresh key file");
});

test("review 16: Community Cloud with a network volume is refused at settings time (volumes are Secure Cloud only)", async () => {
  const { services } = fixture();
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" });
  await assert.rejects(services.updateSettings({ cloudType: "COMMUNITY" }), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid" && /Community Cloud pods cannot mount a network volume/.test(e.message));
  assert.equal((await services.updateSettings({ cloudType: "COMMUNITY", networkVolumeId: null })).networkVolumeId, null);
});

test("review 16: re-saving unchanged compute settings makes no catalog call; only a changed field is validated live", async () => {
  const runpod = fakeRunpod();
  const { services } = fixture({ runpod });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1", gpuTypeId: "NVIDIA GeForce RTX 4090", networkVolumeId: "vol-eu", templateId: "tpl1" });
  const before = runpod.calls.length;
  await services.updateSettings({ datacenterId: "EU-RO-1", gpuTypeId: "NVIDIA GeForce RTX 4090", cloudType: "SECURE", templateId: "tpl1" }); // the Compute card's full resend
  assert.equal(runpod.calls.length, before, "nothing changed, nothing asked");
  await services.updateSettings({ datacenterId: "US-TX-3", gpuTypeId: "NVIDIA GeForce RTX 4090", cloudType: "SECURE", templateId: "tpl1", networkVolumeId: "vol-us" });
  assert.ok(runpod.calls.length > before, "a changed datacenter is validated");
});

test("review 18: an operator createPod that fails AFTER RunPod created the pod keeps the volume lock with that pod (found by name); only a confirmed 'no pod' releases it", async () => {
  const { createMemoryVolumeLockStore, createVolumeLock } = await import("./volume-lock");
  const runpod = fakeRunpod();
  const client = runpod.client as unknown as Record<string, unknown>;
  let livePods: Array<{ id: string; name: string; status: string }> = [];
  client.createPod = async () => {
    throw new Error("RunPod API request failed: timeout");
  };
  client.listPods = async () => livePods;
  const store = createMemoryVolumeLockStore();
  const volumeLock = createVolumeLock({ store, isHolderActive: async () => true });
  const { services } = fixture({ runpod, volumeLock });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" });
  const body = { name: "ytm-models-pull", image: "python:3.12-slim", cpu: { id: "cpu3c", vcpuCount: 2 }, cloud: "SECURE", mounts: { network: [{ volumeId: "vol-eu", path: "/workspace" }] } };
  livePods = [{ id: "p-orphan", name: "ytm-models-pull", status: "RUNNING" }];
  await assert.rejects(services.createPod(body));
  assert.equal(store.current(), "pod:ytm-models-pull", "the pod exists: the lock stays with it");
  await store.release("pod:ytm-models-pull");
  livePods = [];
  await assert.rejects(services.createPod(body));
  assert.equal(store.current(), null, "no pod: released");
});

test("review 19: an operator createPod with no usable credentials never leaves a volume lock behind (the client is resolved before the lock is taken)", async () => {
  const { createMemoryVolumeLockStore, createVolumeLock } = await import("./volume-lock");
  const store = createMemoryVolumeLockStore();
  const volumeLock = createVolumeLock({ store, isHolderActive: async () => true });
  const { services, mem } = fixture({ volumeLock });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" });
  await mem.store.clearCredentials();
  await assert.rejects(services.createPod({ name: "ytm-media", image: "python:3.12-slim", cpu: { id: "cpu3c", vcpuCount: 2 }, cloud: "SECURE", mounts: { network: [{ volumeId: "vol-eu", path: "/workspace" }] } }), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  assert.equal(store.current(), null);
});

test("review 20: re-saving the SAME GPU repairs a missing price (the remedy requestSession's error names), instead of being skipped as unchanged", async () => {
  const runpod = fakeRunpod();
  const { services, mem } = fixture({ runpod });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await services.updateSettings({ gpuTypeId: "NVIDIA GeForce RTX 4090" });
  // The stored price is lost (a salvage, a catalog without a price at the time).
  const stored = JSON.parse((await mem.store.getSettingsJson()) ?? "{}") as Record<string, unknown>;
  await mem.store.setSettingsJson(JSON.stringify({ ...stored, gpuOnDemandPricePerHr: null }));
  assert.equal((await services.getSettings()).gpuOnDemandPricePerHr, null);
  const repaired = await services.updateSettings({ gpuTypeId: "NVIDIA GeForce RTX 4090" }); // the Compute card's Save with the same GPU
  assert.equal(repaired.gpuOnDemandPricePerHr, 0.69);
});

test("slice 0: an S3 secret that is really the access key id (user_..., or equal to the id) is refused at save -- it would only fail later as SignatureDoesNotMatch", async () => {
  const { services } = fixture();
  await assert.rejects(services.setCredentials({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_3IY51Cj8eiVEk36oJCo6OWthnSC", s3SecretAccessKey: "user_3IY51Cj8eiVEk36oJCo6OWthnSC" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed" && /looks like the access key id/.test(JSON.stringify(e.details)));
  await assert.rejects(services.setCredentials({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_a", s3SecretAccessKey: "user_b" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.equal((await services.setCredentials({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_a", s3SecretAccessKey: "rps_secret_value" })).configured, true);
});

// -- BL-172 (GPU_AVAILABILITY_PLAN.md §4): the live availability read through the real gateway client, with a stubbed network --------

function catalogRunpod(options: { gatewayOff?: boolean; status?: number } = {}) {
  const urls: string[] = [];
  const keysSeen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("/catalog/datacenters")
      ? { dataCenters: [{ id: "EU-RO-1", name: "EU-RO-1", region: "EUROPE", networkVolumeTypes: ["STANDARD"] }] }
      : { gpus: [{ id: "NVIDIA GeForce RTX 4090", name: "RTX 4090", memory: 24, secure: true, availability: "HIGH", price: { secure: 0.89 }, dataCenters: [{ id: "EU-RO-1", availability: "MEDIUM" }], cudaVersions: [{ version: "12.8", available: true }] }] };
    return new Response(JSON.stringify(options.status ? { detail: "denied" } : body), { status: options.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const authorize = async () => {
    if (options.gatewayOff) throw new DomainError({ code: "media_gateway_disabled", message: "The media gateway is disabled." });
  };
  return {
    urls,
    keysSeen,
    calls: [] as string[],
    client: undefined as unknown as RunpodApiClient,
    factory: (apiKey: string) => {
      keysSeen.push(apiKey);
      return createRunpodApiClient({ apiKey, fetchImpl, authorize });
    },
  };
}

test("AC-GA-01: the availability read makes two catalog reads with the Settings' cloud and CUDA minimum, and names the volume's datacenter", async () => {
  const runpod = catalogRunpod();
  const { services, mem } = fixture({ runpod });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await mem.store.setSettingsJson(JSON.stringify({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1" }));
  const answer = await services.getGpuAvailability({});
  assert.equal(runpod.urls.length, 2);
  const gpusUrl = new URL(runpod.urls.find((u) => u.includes("/catalog/gpus")) ?? "");
  assert.equal(gpusUrl.searchParams.get("cloud"), "SECURE");
  assert.equal(gpusUrl.searchParams.get("minCudaVersion"), "12.8");
  assert.ok(runpod.urls.some((u) => new URL(u).pathname === "/v2/catalog/datacenters"));
  assert.equal(answer.volumeDataCenterId, "EU-RO-1");
  assert.equal(answer.minCudaVersion, "12.8");
  assert.equal(answer.minVramGb, 24);
  assert.deepEqual(answer.gpus[0].dataCenters, [{ dataCenterId: "EU-RO-1", stock: "MEDIUM", networkVolume: true, s3Api: true }]);
  assert.ok(!JSON.stringify(answer).includes(RUNPOD_KEY), "the key never appears in the answer");
  await services.getGpuAvailability({ minCudaVersion: "12.4" });
  assert.equal(new URL(runpod.urls.filter((u) => u.includes("/catalog/gpus"))[1]).searchParams.get("minCudaVersion"), "12.4", "an input version replaces the Settings' one");
});

test("AC-GA-03: no credentials is media_generation_not_configured and the gateway is never reached; the gateway switched off is media_gateway_disabled with no network call", async () => {
  const unconfigured = catalogRunpod();
  await assert.rejects(fixture({ runpod: unconfigured }).services.getGpuAvailability({}), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  assert.deepEqual(unconfigured.keysSeen, []);
  assert.deepEqual(unconfigured.urls, []);

  const off = catalogRunpod({ gatewayOff: true });
  const blocked = fixture({ runpod: off });
  await blocked.services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await assert.rejects(blocked.services.getGpuAvailability({}), (e: unknown) => isDomainError(e) && e.code === "media_gateway_disabled" && !JSON.stringify({ m: (e as Error).message, d: e.details }).includes(RUNPOD_KEY));
  assert.deepEqual(off.urls, []);

  const refused = catalogRunpod({ status: 401 });
  const rejected = fixture({ runpod: refused });
  await rejected.services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await assert.rejects(rejected.services.getGpuAvailability({}), (e: unknown) => isDomainError(e) && e.code === "media_credentials_invalid" && !JSON.stringify({ m: (e as Error).message, d: e.details }).includes(RUNPOD_KEY));
});

test("AC-GA-02: a bad availability input is validation_failed before any RunPod call", async () => {
  const runpod = catalogRunpod();
  const { services } = fixture({ runpod });
  await services.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await assert.rejects(services.getGpuAvailability({ minCudaVersion: "99.9" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(services.getGpuAvailability({ region: "EU" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.deepEqual(runpod.urls, []);
});
