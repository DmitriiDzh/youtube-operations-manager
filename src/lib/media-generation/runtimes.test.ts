import assert from "node:assert/strict";
import test from "node:test";
import type { RunpodS3Client } from "@/lib/media-gateway";
import { DEFAULT_MEDIA_SETTINGS, isDomainError, type MediaSettings } from "./contracts";
import type { MediaControlEvent } from "./models";
import { createRuntimeServices, isAllowedSource, runtimeKey } from "./runtimes";
import { SHARED_SETTING_FIELDS } from "./settings-sync";

// BL-200 (docs/roadmap/plans/POD_RUNTIMES_PLAN.md AC-RT-01, -02, -08; ADR 0043): a profile is one immutable file on the volume;
// sources must be under the owner's allow-list; node packs name exact commits; a ComfyUI tag is resolved to its commit; pip is pinned.

const SHA = "6607f36b53c7b695b160ac5b52d595e9e3752a2d";
const NODE_SHA = "a".repeat(40);

function harness(settings: Partial<MediaSettings> = {}) {
  const objects = new Map<string, string>();
  const events: MediaControlEvent[] = [];
  const resolved: string[] = [];
  const s3 = {
    async listAllObjects(prefix: string) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1, lastModified: null, etag: null }));
    },
    async getObjectText(key: string) {
      return objects.get(key) ?? null;
    },
    async headObject(key: string) {
      return objects.has(key) ? { size: objects.get(key)!.length, etag: null, lastModified: null } : null;
    },
    async putObject(key: string, body: string | Uint8Array) {
      objects.set(key, String(body));
    },
  } as unknown as RunpodS3Client;
  const services = createRuntimeServices({
    s3: async () => s3,
    github: {
      listReleases: async () => [{ tag: "v0.41.0", name: "v0.41.0", publishedAt: "2026-10-16T10:00:00Z", prerelease: false }],
      resolveCommit: async (owner, repo, ref) => {
        resolved.push(`${owner}/${repo}@${ref}`);
        return { commit: SHA, date: null };
      },
    },
    getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, ...settings }),
    events: { record: async (e) => void events.push(e) },
    clock: { now: () => new Date("2026-10-18T15:00:00Z") },
  });
  return { services, objects, events, resolved };
}

const valid = (overrides: Record<string, unknown> = {}) => ({
  runtimeId: "comfy-0410-flux3",
  name: "ComfyUI 0.41 + KJNodes",
  comfy: { ref: "v0.41.0" },
  customNodes: [{ repo: "https://github.com/kijai/ComfyUI-KJNodes", commit: NODE_SHA }],
  pip: ["sageattention==2.2.0"],
  ...overrides,
});

test("AC-RT-08: defaults -- the switch on, the five allowed sources, $0.5 per test, no active runtime; all four are shared settings", () => {
  assert.equal(DEFAULT_MEDIA_SETTINGS.factoryMayActivateRuntime, true);
  assert.equal(DEFAULT_MEDIA_SETTINGS.runtimeTestMaxUsd, 0.5);
  assert.equal(DEFAULT_MEDIA_SETTINGS.activeRuntimeId, null);
  assert.deepEqual(DEFAULT_MEDIA_SETTINGS.runtimeSourceAllowlist, [
    "https://github.com/comfyanonymous/",
    "https://github.com/Comfy-Org/",
    "https://github.com/kijai/",
    "https://github.com/ltdrdata/",
    "https://huggingface.co/",
  ]);
  for (const field of ["activeRuntimeId", "factoryMayActivateRuntime", "runtimeSourceAllowlist", "runtimeTestMaxUsd"]) {
    assert.ok((SHARED_SETTING_FIELDS as readonly string[]).includes(field), field);
  }
});

test("AC-RT-02: a ComfyUI tag is resolved to its 40-hex commit through GitHub; the stored profile holds the commit; created event", async () => {
  const h = harness();
  const runtime = await h.services.createRuntime(valid(), { actor: "factory" });
  assert.deepEqual(h.resolved, ["comfyanonymous/ComfyUI@v0.41.0"]);
  const stored = JSON.parse(h.objects.get(runtimeKey("comfy-0410-flux3", "runtime.json"))!);
  assert.deepEqual(stored.comfy, { repo: "https://github.com/comfyanonymous/ComfyUI", commit: SHA, ref: "v0.41.0" });
  assert.deepEqual(stored.customNodes, [{ repo: "https://github.com/kijai/ComfyUI-KJNodes", commit: NODE_SHA }]);
  assert.equal(stored.createdBy, "factory");
  assert.equal(runtime.status, "created");
  assert.equal(runtime.active, false);
  assert.deepEqual(h.events.map((e) => [e.actor, e.action, e.subject]), [["factory", "runtime_created", "comfy-0410-flux3"]]);
});

test("AC-RT-02: an exact commit is stored as given with no GitHub call; the same id twice is refused (profiles are never edited)", async () => {
  const h = harness();
  await h.services.createRuntime(valid({ comfy: { ref: SHA.toUpperCase() } }));
  assert.deepEqual(h.resolved, []);
  await assert.rejects(h.services.createRuntime(valid()), (e: unknown) => isDomainError(e) && e.code === "validation_failed" && /never edited/.test((e as Error).message));
});

test("AC-RT-01: an unlisted source, a non-40-hex commit, an unpinned pip entry, an http:// URL or a repeated pack is refused and nothing is written", async () => {
  const cases = [
    valid({ customNodes: [{ repo: "https://github.com/someone-else/nodes", commit: NODE_SHA }] }),
    valid({ customNodes: [{ repo: "https://github.com/kijai/ComfyUI-KJNodes", commit: "abc123" }] }),
    valid({ pip: ["sageattention"] }),
    valid({ pip: ["sageattention>=2"] }),
    valid({ customNodes: [{ repo: "http://github.com/kijai/ComfyUI-KJNodes", commit: NODE_SHA }] }),
    valid({ comfy: { repo: "https://github.com/evil/ComfyUI", ref: "v1" } }),
    valid({ customNodes: [{ repo: "https://github.com/kijai/ComfyUI-KJNodes", commit: NODE_SHA }, { repo: "https://github.com/KIJAI/ComfyUI-KJNodes.git", commit: NODE_SHA }] }),
  ];
  for (const input of cases) {
    const h = harness();
    await assert.rejects(h.services.createRuntime(input), (e: unknown) => isDomainError(e) && e.code === "validation_failed", JSON.stringify(input));
    assert.equal(h.objects.size, 0);
  }
});

test("AC-RT-01: the allow-list is the owner's -- a source added there is accepted; a Hugging Face ComfyUI needs an exact commit", async () => {
  const h = harness({ runtimeSourceAllowlist: ["https://github.com/comfyanonymous/", "https://github.com/someone-else/"] });
  await h.services.createRuntime(valid({ customNodes: [{ repo: "https://github.com/someone-else/nodes", commit: NODE_SHA }] }));
  const hf = harness();
  await assert.rejects(hf.services.createRuntime(valid({ runtimeId: "hf-comfy", comfy: { repo: "https://huggingface.co/someone/ComfyUI", ref: "main" } })), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
});

test("isAllowedSource: prefix by whole path segment, case-insensitive, https only", () => {
  const list = ["https://github.com/kijai/"];
  assert.equal(isAllowedSource("https://github.com/kijai/ComfyUI-KJNodes", list), true);
  assert.equal(isAllowedSource("https://GitHub.com/Kijai/x", list), true);
  assert.equal(isAllowedSource("https://github.com/kijaiX/x", list), false);
  assert.equal(isAllowedSource("http://github.com/kijai/x", list), false);
});

test("listRuntimes / getRuntime: profiles from the volume, newest first, with active and status; build.json and test.json are read", async () => {
  const h = harness({ activeRuntimeId: "comfy-0410-flux3" });
  await h.services.createRuntime(valid());
  h.objects.set(runtimeKey("comfy-0410-flux3", "build.json"), JSON.stringify({ ok: true, seconds: 540 }));
  h.objects.set(
    runtimeKey("comfy-0410-flux3", "test.json"),
    JSON.stringify({ ok: true, testedAt: "2026-10-18T16:00:00Z", comfyVersion: "0.41.0", nodes: ["KSampler", "ReferenceMultiLatent"], templates: [{ templateId: "p3-flux3-klein-edit", version: 1, ok: true, missing: [] }], costUsd: 0.05, bootSeconds: 32 })
  );
  const list = await h.services.listRuntimes();
  assert.equal(list.activeRuntimeId, "comfy-0410-flux3");
  assert.equal(list.runtimes.length, 1);
  assert.deepEqual([list.runtimes[0].status, list.runtimes[0].active, list.runtimes[0].test?.nodeCount], ["tested", true, 2]);
  assert.ok(!("nodes" in (list.runtimes[0].test ?? {})), "the node list itself is not listed");
  const one = await h.services.getRuntime("comfy-0410-flux3");
  assert.deepEqual(one.templates, [{ templateId: "p3-flux3-klein-edit", version: 1, ok: true, missing: [] }]);
  assert.deepEqual([...(await h.services.testedNodes("comfy-0410-flux3"))!.nodes].sort(), ["KSampler", "ReferenceMultiLatent"]);
  await assert.rejects(h.services.getRuntime("nope"), (e: unknown) => isDomainError(e) && e.code === "not_found");
});
