import assert from "node:assert/strict";
import test from "node:test";
import type { MediaControlEvent } from "./models";
import { createMediaJobServices, type MediaJobStore, type StoredTemplateRow } from "./jobs";
import { checkDeclaredModels, graphModelReferences, parseRegistryIndex, registryTemplateFileName } from "./template-registry";
import { isDomainError } from "./contracts";

// BL-132 (docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md §2.3, AC-FM-07..10; owner decisions D3/O1/O3 in
// FO-MSG-0005/0006). Expected outcomes are stated from the plan's sync rules, written before the sync was run:
// install under the registry id/version; a lower version or same-version-other-content is refused and the installed one
// kept; a missing/unreadable index changes nothing; a file not there yet is pending; an id removed from the index is
// removed; owner-imported templates are never touched; a loader naming an undeclared model makes the template invalid.

const GRAPH = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-schnell-fp8.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "x", clip: ["4", 1] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["6", 0] } },
};
const PARAMS = [{ name: "prompt", type: "text", nodeId: "6", input: "text", required: true }];
const MODELS = [{ folder: "checkpoints", file: "flux1-schnell-fp8.safetensors", sha256: "a".repeat(64) }];

function templateFile(templateId: string, version: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: "ytm.media-template", schemaVersion: 1, templateId, version, name: `${templateId} v${version}`, description: null, workflow: GRAPH, parameters: PARAMS, models: MODELS, ...overrides });
}

function indexFile(templates: Array<{ templateId: string; version: number }>): string {
  return JSON.stringify({ schema: "ytm.media-template-index", schemaVersion: 1, templates });
}

function harness() {
  const templates = new Map<string, StoredTemplateRow>();
  const folder = new Map<string, string>();
  let unreadable: string | null = null;
  const events: MediaControlEvent[] = [];
  let lastSync: string | null = null;
  let adoptions: string | null = null;
  let ids = 0;
  const store = {
    templates: {
      async insert(row: Omit<StoredTemplateRow, "version" | "createdAt" | "updatedAt">) {
        const t: StoredTemplateRow = { ...row, version: 1, createdAt: new Date(), updatedAt: new Date(), source: "owner" };
        templates.set(row.id, t);
        return t;
      },
      async update() {
        return null;
      },
      async get(id: string) {
        return templates.get(id) ?? null;
      },
      async list() {
        return [...templates.values()];
      },
      async delete(id: string) {
        return templates.delete(id);
      },
      async upsertFactory(row: Parameters<MediaJobStore["templates"]["upsertFactory"]>[0]) {
        const existing = templates.get(row.id);
        if (existing && (existing.source ?? "owner") !== "factory") return null;
        const t: StoredTemplateRow = { ...row, source: "factory", createdAt: existing?.createdAt ?? new Date(), updatedAt: new Date() };
        templates.set(row.id, t);
        return t;
      },
    },
  } as unknown as MediaJobStore;
  const unused = async () => {
    throw new Error("not used by the registry sync");
  };
  const services = createMediaJobServices({
    store,
    sessions: { getRunningSession: async () => null, comfyClientForSession: unused, touchActivity: async () => {} },
    s3: unused,
    resolveOutputRoot: unused,
    fs: { mkdirp: async () => {}, sha256File: async () => "", remove: async () => {}, writeFileAtomic: async () => {} },
    device: async () => ({ deviceId: null, hostname: null }),
    registerAsset: unused,
    findAssetByLocalPath: async () => null,
    generateId: () => `uuid-owner-${++ids}`,
    clock: { now: () => new Date("2026-10-06T12:00:00Z") },
    sleep: async () => {},
    schedule: () => {},
    registry: {
      async read() {
        if (unreadable) {
          const { DomainError } = await import("./contracts");
          throw new DomainError({ code: "media_template_registry_unavailable", message: unreadable });
        }
        const indexText = folder.get("index.json");
        if (indexText === undefined) {
          const { DomainError } = await import("./contracts");
          throw new DomainError({ code: "media_template_registry_unavailable", message: "index.json is missing" });
        }
        return { indexText, readTemplateFile: async (name: string) => folder.get(name) ?? null };
      },
    },
    events: { record: async (e) => void events.push(e) },
    syncState: { get: async () => lastSync, set: async (json) => void (lastSync = json) },
    adoptions: { get: async () => adoptions, set: async (json) => void (adoptions = json) },
  });
  const publish = (entries: Array<{ templateId: string; version: number; overrides?: Record<string, unknown> }>) => {
    folder.set("index.json", indexFile(entries.map(({ templateId, version }) => ({ templateId, version }))));
    for (const e of entries) folder.set(registryTemplateFileName(e.templateId, e.version), templateFile(e.templateId, e.version, e.overrides));
  };
  return { services, templates, folder, events, publish, setUnreadable: (m: string | null) => void (unreadable = m), lastSync: () => lastSync, adoptions: () => adoptions };
}

test("AC-FM-07: a valid registry template is installed under its registry id and version, as a factory template with its declared models", async () => {
  const h = harness();
  h.publish([{ templateId: "flux-schnell-txt2img", version: 3 }]);
  const result = await h.services.syncTemplatesFromRegistry({ trigger: "factory" });
  assert.deepEqual(result?.installed, [{ templateId: "flux-schnell-txt2img", version: 3 }]);
  const listed = await h.services.listWorkflowTemplates();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].templateId, "flux-schnell-txt2img");
  assert.equal(listed[0].version, 3);
  assert.equal(listed[0].source, "factory");
  assert.deepEqual(listed[0].models, [{ folder: "checkpoints", file: "flux1-schnell-fp8.safetensors", sha256: "a".repeat(64) }]);
  assert.deepEqual(listed[0].parameters.map((p) => p.name), ["prompt"]);
  assert.deepEqual(h.events.map((e) => [e.actor, e.action, e.subject]), [["factory", "template_installed", "flux-schnell-txt2img"]]);
});

test("AC-FM-07: the same registry files give the same ids, versions and parameters on two devices", async () => {
  const mac = harness();
  const windows = harness();
  for (const h of [mac, windows]) {
    h.publish([{ templateId: "a-template", version: 2 }, { templateId: "b-template", version: 7 }]);
    await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  }
  const shape = async (h: ReturnType<typeof harness>) => (await h.services.listWorkflowTemplates()).map((t) => [t.templateId, t.version, JSON.stringify(t.parameters), t.source]);
  assert.deepEqual(await shape(mac), await shape(windows));
});

test("AC-FM-08: a lower version is refused and the installed one stays; same version with different content is refused; a higher version replaces", async () => {
  const h = harness();
  h.publish([{ templateId: "t-one", version: 5 }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });

  h.folder.clear();
  h.publish([{ templateId: "t-one", version: 4 }]); // a stale copy from another device
  const lower = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.match(lower?.invalid[0]?.reason ?? "", /lower than the installed 5/);
  assert.equal((await h.services.listWorkflowTemplates())[0].version, 5);

  h.folder.clear();
  h.publish([{ templateId: "t-one", version: 5, overrides: { name: "edited without a bump" } }]);
  const same = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.match(same?.invalid[0]?.reason ?? "", /different content/);
  assert.equal((await h.services.listWorkflowTemplates())[0].name, "t-one v5");

  h.folder.clear();
  h.publish([{ templateId: "t-one", version: 6 }]);
  const higher = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.deepEqual(higher?.updated, [{ templateId: "t-one", from: 5, to: 6 }]);
  assert.equal((await h.services.listWorkflowTemplates())[0].version, 6);
});

test("AC-FM-08: a missing or unreadable index (or an unreadable folder) changes nothing; a listed file not there yet is pending and the installed version stays", async () => {
  const h = harness();
  h.publish([{ templateId: "keep-me", version: 1 }, { templateId: "also-me", version: 1 }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });

  h.folder.delete("index.json");
  const missing = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.equal(missing?.outcome, "unavailable");
  assert.equal((await h.services.listWorkflowTemplates()).length, 2, "an index that vanished (drive unmounted) deletes nothing");

  h.folder.set("index.json", "{ broken");
  assert.equal((await h.services.syncTemplatesFromRegistry({ trigger: "auto" }))?.outcome, "unavailable");
  h.folder.set("index.json", JSON.stringify({ schema: "ytm.media-template-index", schemaVersion: 2, templates: [] }));
  assert.equal((await h.services.syncTemplatesFromRegistry({ trigger: "auto" }))?.outcome, "unavailable");
  h.setUnreadable("the registry folder is not configured on this device");
  assert.equal((await h.services.syncTemplatesFromRegistry({ trigger: "auto" }))?.outcome, "unavailable");
  h.setUnreadable(null);
  assert.equal((await h.services.listWorkflowTemplates()).length, 2);

  // v2 of keep-me is listed but its file has not been copied yet.
  h.folder.set("index.json", indexFile([{ templateId: "keep-me", version: 2 }, { templateId: "also-me", version: 1 }]));
  const pending = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.deepEqual(pending?.pending, [{ templateId: "keep-me", version: 2 }]);
  assert.equal((await h.services.listWorkflowTemplates()).find((t) => t.templateId === "keep-me")?.version, 1);
});

test("AC-FM-09: a template no longer in the index is removed; owner-imported templates are never touched, and a registry id equal to a local template's id is refused", async () => {
  const h = harness();
  const local = await h.services.importWorkflowTemplate({ name: "my local test", workflow: GRAPH, parameters: PARAMS });
  assert.equal(local.source, "owner");
  h.publish([{ templateId: "goes-away", version: 1 }, { templateId: "stays", version: 1 }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  h.folder.clear();
  h.publish([{ templateId: "stays", version: 1 }, { templateId: local.templateId, version: 1 }]);
  const result = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.deepEqual(result?.removed, [{ templateId: "goes-away", version: 1 }]);
  assert.match(result?.invalid.find((i) => i.templateId === local.templateId)?.reason ?? "", /imported by hand/);
  const ids = (await h.services.listWorkflowTemplates()).map((t) => [t.templateId, t.source]).sort();
  assert.deepEqual(ids, [["stays", "factory"], [local.templateId, "owner"]].sort());
  assert.deepEqual(h.events.filter((e) => e.action === "template_removed").map((e) => [e.actor, e.subject]), [["sync", "goes-away"]]);
});

test("AC-FM-10: a loader naming a model that is not in the declared list (or a free-text parameter on a loader input) makes the template invalid; it is not installed", async () => {
  const h = harness();
  h.publish([
    { templateId: "undeclared", version: 1, overrides: { models: [] } },
    {
      templateId: "free-text-model",
      version: 1,
      overrides: { parameters: [...PARAMS, { name: "ckpt", type: "string", nodeId: "4", input: "ckpt_name", required: false, default: "flux1-schnell-fp8.safetensors" }] },
    },
    {
      templateId: "enum-ok",
      version: 1,
      overrides: {
        parameters: [...PARAMS, { name: "ckpt", type: "enum", nodeId: "4", input: "ckpt_name", enum: ["flux1-schnell-fp8.safetensors", "other.safetensors"], default: "flux1-schnell-fp8.safetensors" }],
        models: [...MODELS, { folder: "checkpoints", file: "other.safetensors" }],
      },
    },
  ]);
  const result = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.deepEqual(result?.invalid.map((i) => i.templateId).sort(), ["free-text-model", "undeclared"]);
  assert.match(result?.invalid.find((i) => i.templateId === "undeclared")?.reason ?? "", /checkpoints\/flux1-schnell-fp8\.safetensors.*not in the template's models list/);
  assert.deepEqual(result?.installed, [{ templateId: "enum-ok", version: 1 }]);
});

test("a template file that does not match its index entry, or fails the structural checks, is invalid", async () => {
  const h = harness();
  h.folder.set("index.json", indexFile([{ templateId: "mismatch", version: 2 }, { templateId: "no-save", version: 1 }]));
  h.folder.set(registryTemplateFileName("mismatch", 2), templateFile("mismatch", 3));
  h.folder.set(registryTemplateFileName("no-save", 1), templateFile("no-save", 1, { workflow: { "4": GRAPH["4"], "6": GRAPH["6"] } }));
  const result = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.match(result?.invalid.find((i) => i.templateId === "mismatch")?.reason ?? "", /index lists mismatch v2/);
  assert.match(result?.invalid.find((i) => i.templateId === "no-save")?.reason ?? "", /no Save node/);
  assert.deepEqual(result?.installed, []);
});

test("a dry run reports what would change and writes nothing; only a real run is kept as the last result", async () => {
  const h = harness();
  h.publish([{ templateId: "dry", version: 1 }]);
  const dry = await h.services.syncTemplatesFromRegistry({ trigger: "factory", dryRun: true });
  assert.deepEqual(dry?.installed, [{ templateId: "dry", version: 1 }]);
  assert.equal(dry?.dryRun, true);
  assert.deepEqual(await h.services.listWorkflowTemplates(), []);
  assert.equal(h.lastSync(), null);
  await h.services.syncTemplatesFromRegistry({ trigger: "owner" });
  assert.equal((await h.services.getLastTemplateSync())?.trigger, "owner");
});

test("O1: the 60 s check skips a sync when the registry reads exactly as before, and runs when a file changed", async () => {
  const h = harness();
  h.publish([{ templateId: "auto-one", version: 1 }]);
  assert.ok(await h.services.syncTemplatesFromRegistry({ trigger: "auto", onlyIfChanged: true }));
  assert.equal(await h.services.syncTemplatesFromRegistry({ trigger: "auto", onlyIfChanged: true }), null);
  h.publish([{ templateId: "auto-one", version: 2 }]);
  const changed = await h.services.syncTemplatesFromRegistry({ trigger: "auto", onlyIfChanged: true });
  assert.deepEqual(changed?.updated, [{ templateId: "auto-one", from: 1, to: 2 }]);
});

test("factory-installed templates are read-only in the Web UI/CLI: update and delete are refused", async () => {
  const h = harness();
  h.publish([{ templateId: "managed", version: 1 }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  await assert.rejects(h.services.updateWorkflowTemplate({ templateId: "managed", name: "renamed" }), (e: unknown) => isDomainError(e) && e.code === "media_template_invalid");
  await assert.rejects(h.services.deleteWorkflowTemplate({ templateId: "managed" }), (e: unknown) => isDomainError(e) && e.code === "media_template_invalid");
});

test("registry format: the index must be ytm.media-template-index v1 with unique ids; loader references are read from known loaders only", () => {
  assert.throws(() => parseRegistryIndex(indexFile([{ templateId: "dup", version: 1 }, { templateId: "dup", version: 2 }])), (e: unknown) => isDomainError(e) && e.code === "media_template_registry_unavailable");
  assert.throws(() => parseRegistryIndex(indexFile([{ templateId: "Bad_Id", version: 1 }])), (e: unknown) => isDomainError(e) && e.code === "media_template_registry_unavailable");
  const refs = graphModelReferences({
    "1": { class_type: "DualCLIPLoader", inputs: { clip_name1: "t5xxl.safetensors", clip_name2: "clip_l.safetensors", type: "flux" } },
    "2": { class_type: "LoraLoader", inputs: { lora_name: "styles\\anime.safetensors" } },
    "3": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux.gguf" } },
  });
  assert.deepEqual(refs.map((r) => `${r.folder}/${r.file}`), ["text_encoders/t5xxl.safetensors", "text_encoders/clip_l.safetensors", "loras/styles/anime.safetensors"]);
  assert.deepEqual(checkDeclaredModels({ workflow: { "3": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux.gguf" } } }, parameters: [], models: [] }), [], "custom loaders are not checked (plan §2.3)");
});

test("A1 (plan §2.2): model usage lists installed factory templates, LOCAL templates (models from their loader nodes) and every template the registry lists; an unreadable registry is reported", async () => {
  const h = harness();
  const local = await h.services.importWorkflowTemplate({ name: "local", workflow: { ...GRAPH, "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "my-local.safetensors" } } }, parameters: PARAMS });
  h.publish([{ templateId: "installed", version: 1 }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  // A template only listed (not yet installed here) still protects its models.
  h.folder.set("index.json", indexFile([{ templateId: "installed", version: 1 }, { templateId: "elsewhere", version: 4 }]));
  h.folder.set(registryTemplateFileName("elsewhere", 4), templateFile("elsewhere", 4, { models: [...MODELS, { folder: "loras", file: "style.safetensors" }] }));
  const usage = await h.services.modelUsage();
  assert.equal(usage.registry, "ok");
  const keyed = usage.users.map((u) => `${u.key}<-${u.templateId}@${u.version}:${u.source}`).sort();
  assert.deepEqual(keyed, [
    "models/checkpoints/flux1-schnell-fp8.safetensors<-elsewhere@4:registry",
    "models/checkpoints/flux1-schnell-fp8.safetensors<-installed@1:factory", // listed AND installed: one user, not two
    `models/checkpoints/my-local.safetensors<-${local.templateId}@1:owner`,
    "models/loras/style.safetensors<-elsewhere@4:registry",
  ]);
  h.setUnreadable("drive unmounted");
  const blind = await h.services.modelUsage();
  assert.equal(blind.registry, "unavailable");
  assert.ok(blind.users.some((u) => u.source === "owner"), "installed templates are still known");
});

test("review (fail closed): a template the index lists but whose file is missing, unreadable or invalid makes the registry 'unavailable' for model usage", async () => {
  const h = harness();
  h.publish([{ templateId: "fine", version: 1 }]);
  h.folder.set("index.json", indexFile([{ templateId: "fine", version: 1 }, { templateId: "broken", version: 2 }]));
  assert.equal((await h.services.modelUsage()).registry, "unavailable", "listed file not there");
  h.folder.set(registryTemplateFileName("broken", 2), "{ nope");
  const usage = await h.services.modelUsage();
  assert.equal(usage.registry, "unavailable");
  assert.match(usage.registryError ?? "", /broken v2/);
});

test("review: the 60 s check also notices a change in this device's templates (a local template that blocked a registry id was deleted)", async () => {
  const h = harness();
  const local = await h.services.importWorkflowTemplate({ name: "local", workflow: GRAPH, parameters: PARAMS });
  h.folder.set("index.json", indexFile([{ templateId: local.templateId, version: 1 }]));
  h.folder.set(registryTemplateFileName(local.templateId, 1), templateFile(local.templateId, 1));
  const first = await h.services.syncTemplatesFromRegistry({ trigger: "auto", onlyIfChanged: true });
  assert.equal(first?.invalid.length, 1);
  assert.equal(await h.services.syncTemplatesFromRegistry({ trigger: "auto", onlyIfChanged: true }), null);
  await h.services.deleteWorkflowTemplate({ templateId: local.templateId });
  const after = await h.services.syncTemplatesFromRegistry({ trigger: "auto", onlyIfChanged: true });
  assert.deepEqual(after?.installed, [{ templateId: local.templateId, version: 1 }]);
});

test("BL-133: a registry template may declare its GPU plan; it is installed with the template and listed", async () => {
  const h = harness();
  h.publish([{ templateId: "with-gpu", version: 1, overrides: { gpu: { candidates: ["NVIDIA GeForce RTX 4090", "NVIDIA L40S"], minVramGb: 24 } } }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.deepEqual((await h.services.listWorkflowTemplates())[0].gpu, { candidates: ["NVIDIA GeForce RTX 4090", "NVIDIA L40S"], minVramGb: 24, maxPricePerHr: null });
  h.publish([{ templateId: "bad-gpu", version: 1, overrides: { gpu: { candidates: [] } } }]);
  const result = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.equal(result?.invalid.some((i) => i.templateId === "bad-gpu"), true, "an empty candidate list is invalid");
});

// -- FO-REQ-0005 item 2 (owner decision 2026-10-07, msg 1915: both tools) -------------------------------------------------
// Expected outcomes from FO-REQ-0005's acceptance criterion: after the call the model is no longer `usedBy` the local
// template and can be deleted; the action is in the audit log as done by the factory. Sync never touches a local template
// on its own (O3) -- only one the factory asked to adopt, and only once the registry copy is installed.

async function importLocal(h: ReturnType<typeof harness>, overrides: { workflow?: unknown; parameters?: unknown[] } = {}) {
  return h.services.importWorkflowTemplate({ name: "Owner test FLUX", description: "imported by hand", workflow: overrides.workflow ?? GRAPH, parameters: overrides.parameters ?? PARAMS });
}

const FLUX_KEY = "models/checkpoints/flux1-schnell-fp8.safetensors";

test("FO-REQ-0005: the factory deletes a LOCAL template -- its model is no longer used by it, the audit says the factory did it", async () => {
  const h = harness();
  h.publish([]);
  const local = await importLocal(h);
  assert.deepEqual((await h.services.modelUsage()).users.map((u) => [u.key, u.templateId, u.source]), [[FLUX_KEY, local.templateId, "owner"]]);
  assert.deepEqual(await h.services.deleteWorkflowTemplate({ templateId: local.templateId }, { actor: "factory" }), { deleted: true });
  assert.deepEqual((await h.services.modelUsage()).users, []);
  assert.deepEqual(h.events.map((e) => [e.actor, e.action, e.subject]), [["factory", "template_deleted", local.templateId]]);
});

test("FO-REQ-0005: the factory cannot delete a registry template (it goes via the index) or an unknown one", async () => {
  const h = harness();
  h.publish([{ templateId: "flux-schnell", version: 1 }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "factory" });
  await assert.rejects(h.services.deleteWorkflowTemplate({ templateId: "flux-schnell" }, { actor: "factory" }), (e: unknown) => isDomainError(e) && e.code === "media_template_invalid");
  assert.ok(h.templates.has("flux-schnell"));
  await assert.rejects(h.services.deleteWorkflowTemplate({ templateId: "nope" }, { actor: "factory" }), (e: unknown) => isDomainError(e) && e.code === "media_template_not_found");
});

test("FO-REQ-0005: adopt returns a registry file that a sync accepts as it is; the local copy stays until that file is installed, then it goes", async () => {
  const h = harness();
  h.publish([]);
  const local = await importLocal(h);
  const adoption = await h.services.adoptWorkflowTemplate({ templateId: local.templateId, newTemplateId: "flux-schnell-owner" });
  assert.equal(adoption.status, "pending");
  assert.equal(adoption.fileName, "flux-schnell-owner.v1.json");
  assert.deepEqual(adoption.indexEntry, { templateId: "flux-schnell-owner", version: 1 });
  assert.equal(adoption.template.templateId, "flux-schnell-owner");
  assert.equal(adoption.template.version, 1);
  assert.equal(adoption.template.name, "Owner test FLUX");
  assert.deepEqual(adoption.template.workflow, GRAPH);
  assert.deepEqual(adoption.template.models, [{ folder: "checkpoints", file: "flux1-schnell-fp8.safetensors" }]);
  // Nothing written to the registry, the local copy is still there and still protects its model.
  assert.equal(h.folder.get("flux-schnell-owner.v1.json"), undefined);
  assert.ok(h.templates.has(local.templateId));
  assert.deepEqual(h.events.map((e) => [e.actor, e.action, e.subject]), [["factory", "template_adoption_requested", local.templateId]]);

  // The factory writes exactly what it got; the next sync installs it and removes the local copy.
  h.folder.set(adoption.fileName, JSON.stringify(adoption.template));
  h.folder.set("index.json", indexFile([adoption.indexEntry]));
  const dry = await h.services.syncTemplatesFromRegistry({ trigger: "factory", dryRun: true });
  assert.deepEqual(dry?.installed, [{ templateId: "flux-schnell-owner", version: 1 }]);
  assert.ok(h.templates.has(local.templateId), "a dry run removes nothing");
  const result = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.deepEqual(result?.installed, [{ templateId: "flux-schnell-owner", version: 1 }]);
  assert.deepEqual(result?.invalid, []);
  assert.equal(h.templates.has(local.templateId), false);
  assert.ok((await h.services.modelUsage()).users.every((u) => u.templateId === "flux-schnell-owner"), "no longer used by the local template");
  assert.deepEqual(h.events.filter((e) => e.action === "template_adopted").map((e) => [e.actor, e.subject, e.details?.templateId]), [["factory", local.templateId, "flux-schnell-owner"]]);
  assert.deepEqual(JSON.parse(h.adoptions() ?? "[]"), []);
});

test("FO-REQ-0005: adopting into an id already installed from the registry removes the local copy at once", async () => {
  const h = harness();
  h.publish([{ templateId: "flux-schnell", version: 1 }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "factory" });
  const local = await importLocal(h);
  const adoption = await h.services.adoptWorkflowTemplate({ templateId: local.templateId, newTemplateId: "flux-schnell" });
  assert.equal(adoption.status, "adopted");
  assert.equal(h.templates.has(local.templateId), false);
  assert.ok(h.templates.has("flux-schnell"));
  assert.equal(h.events.at(-1)?.action, "template_adopted");
  assert.equal(h.events.at(-1)?.actor, "factory");
});

test("FO-REQ-0005: adopt refuses a registry template, an id taken by another local template or another adoption, and a template the registry would reject -- nothing changes", async () => {
  const h = harness();
  h.publish([{ templateId: "flux-schnell", version: 1 }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "factory" });
  const a = await importLocal(h);
  const b = await importLocal(h);
  const refused = (code: string) => (e: unknown) => isDomainError(e) && e.code === code;
  await assert.rejects(h.services.adoptWorkflowTemplate({ templateId: "flux-schnell", newTemplateId: "other-id" }), refused("media_template_invalid"));
  await assert.rejects(h.services.adoptWorkflowTemplate({ templateId: a.templateId, newTemplateId: b.templateId }), refused("media_template_invalid"));
  await assert.rejects(h.services.adoptWorkflowTemplate({ templateId: a.templateId, newTemplateId: "Bad_Id" }), refused("validation_failed"));
  await assert.rejects(h.services.adoptWorkflowTemplate({ templateId: "missing", newTemplateId: "x-1" }), refused("media_template_not_found"));
  await h.services.adoptWorkflowTemplate({ templateId: a.templateId, newTemplateId: "taken-target" });
  await assert.rejects(h.services.adoptWorkflowTemplate({ templateId: b.templateId, newTemplateId: "taken-target" }), refused("media_template_invalid"));
  // A free-text parameter on a loader input: a registry sync would refuse it, so adopt does too, and says why.
  const freeText = await importLocal(h, { parameters: [...PARAMS, { name: "model", type: "text", nodeId: "4", input: "ckpt_name", required: false }] });
  await assert.rejects(
    h.services.adoptWorkflowTemplate({ templateId: freeText.templateId, newTemplateId: "free-text" }),
    (e: unknown) => isDomainError(e) && e.code === "media_template_invalid" && Array.isArray((e.details as { problems: unknown[] }).problems) && /must be an enum/.test(e.message)
  );
  assert.ok(h.templates.has(a.templateId) && h.templates.has(b.templateId) && h.templates.has(freeText.templateId));
  assert.deepEqual(JSON.parse(h.adoptions() ?? "[]").map((x: { templateId: string }) => x.templateId), ["taken-target"]);
});

test("FO-REQ-0005: a pending adoption of a template the owner then deletes is forgotten; a sync without the registry copy keeps the local one", async () => {
  const h = harness();
  h.publish([]);
  const kept = await importLocal(h);
  const dropped = await importLocal(h);
  await h.services.adoptWorkflowTemplate({ templateId: kept.templateId, newTemplateId: "kept-one" });
  await h.services.adoptWorkflowTemplate({ templateId: dropped.templateId, newTemplateId: "dropped-one" });
  await h.services.deleteWorkflowTemplate({ templateId: dropped.templateId });
  assert.deepEqual(JSON.parse(h.adoptions() ?? "[]").map((x: { localTemplateId: string }) => x.localTemplateId), [kept.templateId]);
  assert.equal(h.events.at(-1)?.actor, "owner");
  assert.equal(h.events.at(-1)?.action, "template_deleted");
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.ok(h.templates.has(kept.templateId), "the registry does not have kept-one yet");
});

// Independent review (FO-REQ-0005): the local template is removed ONLY when the registry template under the adopted id is
// that template -- same graph and parameters. Expected: an unrelated template using the id costs the owner nothing.
const OTHER_GRAPH = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-schnell-fp8.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a completely different prompt graph", clip: ["4", 1] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "Other", images: ["6", 0] } },
};

test("FO-REQ-0005 review: adopting into an id installed with a DIFFERENT graph is refused and the local template is kept", async () => {
  const h = harness();
  h.publish([{ templateId: "flux-schnell", version: 3, overrides: { workflow: OTHER_GRAPH } }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "factory" });
  const local = await importLocal(h);
  await assert.rejects(h.services.adoptWorkflowTemplate({ templateId: local.templateId, newTemplateId: "flux-schnell" }), (e: unknown) => isDomainError(e) && e.code === "media_template_invalid" && /different graph or parameters/.test(e.message));
  assert.ok(h.templates.has(local.templateId));
  assert.equal(h.events.some((e) => e.action === "template_adopted"), false);
});

test("FO-REQ-0005 review: a sync that installs OTHER content under a pending adoption's id keeps the local copy and says so", async () => {
  const h = harness();
  h.publish([]);
  const local = await importLocal(h);
  const adoption = await h.services.adoptWorkflowTemplate({ templateId: local.templateId, newTemplateId: "flux-owner" });
  assert.equal(adoption.status, "pending");
  h.publish([{ templateId: "flux-owner", version: 1, overrides: { workflow: OTHER_GRAPH } }]);
  const result = await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.deepEqual(result?.installed, [{ templateId: "flux-owner", version: 1 }]);
  assert.ok(h.templates.has(local.templateId), "the owner's template is not deleted");
  assert.ok(result?.invalid.some((i) => i.templateId === "flux-owner" && /local copy is kept/.test(i.reason)));
  // Same key order or not: content written back exactly as adopt returned it completes the adoption.
  h.folder.set("flux-owner.v2.json", JSON.stringify({ ...adoption.template, version: 2 }));
  h.folder.set("index.json", indexFile([{ templateId: "flux-owner", version: 2 }]));
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.equal(h.templates.has(local.templateId), false);
});

test("FO-REQ-0005 review: adopting into the local template's own id is refused with a message that says so", async () => {
  const h = harness();
  h.publish([]);
  const local = await importLocal(h);
  await assert.rejects(h.services.adoptWorkflowTemplate({ templateId: local.templateId, newTemplateId: local.templateId }), (e: unknown) => isDomainError(e) && /own id/.test(e.message));
});

test("FO-REQ-0005 review 2: different PARAMETERS alone (same graph) also keep the local template; a reordered but equal file completes the adoption", async () => {
  const h = harness();
  h.publish([]);
  const local = await importLocal(h);
  const adoption = await h.services.adoptWorkflowTemplate({ templateId: local.templateId, newTemplateId: "flux-owner" });
  const otherParams = [{ name: "prompt", type: "text", nodeId: "6", input: "text", required: false }];
  h.publish([{ templateId: "flux-owner", version: 1, overrides: { workflow: GRAPH, parameters: otherParams } }]);
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.ok(h.templates.has(local.templateId), "parameters differ: kept");
  // The same content with every object's keys in reverse order is the same template.
  const reverseKeys = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) : value;
  h.folder.set("flux-owner.v2.json", JSON.stringify(reverseKeys({ ...adoption.template, version: 2 })));
  h.folder.set("index.json", indexFile([{ templateId: "flux-owner", version: 2 }]));
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.equal(h.templates.has(local.templateId), false);
});

test("FO-REQ-0005 review 2: a new pending adoption alone makes the 60 s check run the sync (it is part of the fingerprint)", async () => {
  const h = harness();
  h.publish([]);
  const local = await importLocal(h);
  await h.services.syncTemplatesFromRegistry({ trigger: "auto" });
  assert.equal(await h.services.syncTemplatesFromRegistry({ trigger: "auto", onlyIfChanged: true }), null, "nothing changed: skipped");
  await h.services.adoptWorkflowTemplate({ templateId: local.templateId, newTemplateId: "flux-owner" });
  assert.notEqual(await h.services.syncTemplatesFromRegistry({ trigger: "auto", onlyIfChanged: true }), null);
});
