import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import type { StoryboardsDocument } from "@/lib/sync-gateway/storyboards/contracts";
import { createStoryboardsCore, emptyDocument } from "@/lib/sync-gateway/storyboards/services";
import { isDomainError } from "./contracts";
import { createStoryboardFiles } from "./adapters/files";
import { createStoryboardsService } from "./services";

// BL-184: the storyboards tests' shared harness (named *.test.ts so the inventory scans treat it as test code; it holds no test) -- the bar case of FO-REQ-0024 §5 in a temporary channel folder, on the REAL
// workspace-exchange rules, with an in-memory synced document. Expected sha256 values are computed here with node:crypto over the
// bytes this harness writes, never read back from the module.

export const CH = "UC_tropico";
export const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The bar case of FO-REQ-0024 §5: K0-K3 under `Sent to YTM/H-0004/bar/`, the fixed v2 under `bar/v2/` (K0 unchanged). */
export const V1 = { K0: "bar K0 bytes", K1: "bar K1: glass handed over", K2: "bar K2: glass missing", K3: "bar K3: glass back on the counter" };
export const V2 = { K0: "bar K0 bytes", K1: "bar K1 v2: glass under the counter", K2: "bar K2 v2: glass under the counter", K3: "bar K3 v2: glass under the counter" };

export async function setup(options: { connected?: boolean; workspace?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "storyboards-")));
  const ws = path.join(root, "Tropico Jazz");
  const bar = path.join(ws, "99 Data Exchange", "Sent to YTM", "H-0004", "bar");
  await mkdir(path.join(bar, "v2"), { recursive: true });
  await mkdir(path.join(ws, "99 Data Exchange", "From YTM", "gemini", "gm_job1"), { recursive: true });
  for (const [id, text] of Object.entries(V1)) await writeFile(path.join(bar, `${id}.jpg`), text);
  for (const [id, text] of Object.entries(V2)) await writeFile(path.join(bar, "v2", `${id}.jpg`), text);
  await writeFile(path.join(ws, "99 Data Exchange", "From YTM", "gemini", "gm_job1", "image-1.png"), "gemini still");
  await writeFile(path.join(root, "outside.jpg"), "outside");

  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  const sync = createStoryboardsCore({ core: createAutomergeCore<StoryboardsDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  let clock = Date.parse("2026-10-13T12:00:00.000Z");
  let ids = 0;
  const service = createStoryboardsService({
    store: sync,
    files: createStoryboardFiles(async (channelId) => (channelId === CH && options.workspace !== false ? { configured: true, path: ws } : { configured: false })),
    isChannelConnected: async (channelId) => channelId === CH && options.connected !== false,
    deviceLabel: async () => "Mac",
    now: () => new Date((clock += 60_000)),
    randomId: () => `id${++ids}`,
    withLock: (fn) => fn(),
  });
  return { root, ws, bar, service, sync, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export const keyframes = (folder: string) => ["K0", "K1", "K2", "K3"].map((id) => ({ id, file: `Sent to YTM/H-0004/${folder}/${id}.jpg`, caption: null }));
export const segments = () => [
  { id: "S1", fromKeyframeId: "K0", toKeyframeId: "K1", action: "the bartender hands the glass to the woman", durationSeconds: 8, model: "ltx-2.5-flf", settings: { frames: 193, guide: 0.9 }, estimateUsd: 0.12 },
  { id: "S2", fromKeyframeId: "K1", toKeyframeId: "K2", action: "she drinks and puts the glass down", durationSeconds: 8 },
  { id: "S3", fromKeyframeId: "K2", toKeyframeId: "K3", action: "he wipes the counter", durationSeconds: 8 },
  { id: "S4", fromKeyframeId: "K3", toKeyframeId: "K0", action: "back to the start", durationSeconds: 8 },
];
export const props = (glass: Record<string, string>) => [
  { id: "glass", name: "Glass", kind: "object" as const, cells: glass },
  { id: "towel", name: "Towel", kind: "object" as const, cells: { K0: "folded on the counter", K1: "folded on the counter", K2: "in his hand", K3: "folded on the counter" } },
  { id: "cup", name: "Cup", kind: "object" as const, cells: { K0: "by the machine", K1: "by the machine", K2: "by the machine", K3: "by the machine" } },
  { id: "saucer", name: "Saucer", kind: "object" as const, cells: { K0: "under the cup", K1: "under the cup", K2: "under the cup", K3: "under the cup" } },
];
export const V1_GLASS = { K0: "in his hand", K1: "in her hand", K2: "", K3: "on the counter" };
export const V2_GLASS = { K0: "in his hand", K1: "under the counter", K2: "under the counter", K3: "under the counter" };
export const barLoop = (folder = "bar", glass = V1_GLASS) => ({ channelId: CH, storyboardId: "bar-loop", title: "Bar loop", loop: true, keyframes: keyframes(folder), segments: segments(), props: props(glass), notes: "background nearly still, no gusts, nobody talks" });

export async function code(promise: Promise<unknown>, expected: string, detail?: Record<string, unknown>) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isDomainError(error), `expected a DomainError ${expected}, got ${String(error)}`);
    assert.equal(error.code, expected, error.message);
    if (detail) for (const [key, value] of Object.entries(detail)) assert.deepEqual((error.details as Record<string, unknown>)[key], value);
    return true;
  });
}

