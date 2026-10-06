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
    generateId: () => "uuid-owner-1",
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
  });
  const publish = (entries: Array<{ templateId: string; version: number; overrides?: Record<string, unknown> }>) => {
    folder.set("index.json", indexFile(entries.map(({ templateId, version }) => ({ templateId, version }))));
    for (const e of entries) folder.set(registryTemplateFileName(e.templateId, e.version), templateFile(e.templateId, e.version, e.overrides));
  };
  return { services, templates, folder, events, publish, setUnreadable: (m: string | null) => void (unreadable = m), lastSync: () => lastSync };
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
