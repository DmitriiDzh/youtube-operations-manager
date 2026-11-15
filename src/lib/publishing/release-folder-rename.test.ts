import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import type { StoredPublishingUpload } from "@/lib/db";
import { createReleaseFolderRename, folderNameProblem, rewritePaths, type ReleaseFolderRenameDeps } from "./release-folder-rename";

// BL-261 acceptance (owner TG 3521 via the Factory Operator: rename the WWE Short folders, e.g. «1115 V1» -> «1115 V1 Short»).
// Expected by hand: the folder moves within its month folder; this computer's queued and finished upload rows that name it get the
// new folder in their manifest path and in every package path; refused while the video is sent/processed/finished/paused here, while
// another computer reports it unfinished, or while a cross-post uploads it; a failed row rewrite moves the folder back.

const WS = "/ws";
const FROM = "04 Videos/11 November/1115 V1";
const TO = "04 Videos/11 November/1115 V1 Short";

const row = (id: string, status: string, manifestPath = `${FROM}/V1_release.json`): StoredPublishingUpload =>
  ({
    id,
    channelId: "UC1",
    video: "V1",
    status,
    resumeStatus: null,
    manifestPath,
    packageJson: JSON.stringify({ video: "V1", manifestPath, videoFile: `${FROM}/V1 Short.mp4`, thumbnailFile: `${FROM}/Thumbnail_V1.jpg`, title: `${FROM} is not a path here` }),
  }) as unknown as StoredPublishingUpload;

function harness(over: Partial<ReleaseFolderRenameDeps> = {}, rows: StoredPublishingUpload[] = [row("u1", "done"), row("u2", "queued")]) {
  let folders = new Set([FROM]);
  const calls: string[] = [];
  let stored = rows;
  const deps: ReleaseFolderRenameDeps = {
    workspace: async () => WS,
    scan: async () => ({ status: "ok", packages: [...folders].map((folder) => ({ video: "V1", folder, manifestPath: `${folder}/V1_release.json` })) as never }),
    uploads: async () => stored,
    peerUploads: async () => new Map(),
    socialBusy: async () => false,
    exists: async (abs) => [...folders].some((f) => `${WS}/${f}` === abs) || abs === `${WS}/04 Videos/11 November/taken V1`,
    isRealFolder: async () => true,
    rename: async (from, to) => {
      calls.push(`rename:${from}->${to}`);
      folders = new Set([...folders].map((f) => (`${WS}/${f}` === from ? to.slice(WS.length + 1) : f)));
    },
    rewriteUploads: async (updates) => {
      calls.push(`rewrite:${updates.map((u) => u.id).join(",")}`);
      stored = stored.map((r) => {
        const u = updates.find((x) => x.id === r.id);
        return u ? ({ ...r, manifestPath: u.manifestPath, packageJson: u.packageJson } as StoredPublishingUpload) : r;
      });
      return updates.length;
    },
    assertMutationAllowed: async () => void calls.push("gate"),
    audit: async (entry) => void calls.push(`audit:${entry.detail.event}:${entry.detail.readBack}`),
    invalidate: () => void calls.push("invalidate"),
    join: (...parts) => parts.join("/"),
    ...over,
  };
  return { core: createReleaseFolderRename(deps), calls, rows: () => stored };
}

const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (isDomainError(e) ? `${e.code}:${(e.details as { reason?: string }).reason ?? ""}` : String(e)));

test("BL-261: name rules -- one folder name valid on macOS and Windows that still names the video", () => {
  assert.equal(folderNameProblem("1115 V1 Short", "V1"), null);
  assert.equal(folderNameProblem("V1", "V1"), null);
  assert.equal(folderNameProblem("1115 V12 Short", "V1"), "missing_video");
  assert.equal(folderNameProblem("1115 Short", "V1"), "missing_video");
  assert.equal(folderNameProblem("a/V1", "V1"), "characters");
  assert.equal(folderNameProblem("V1:x", "V1"), "characters");
  assert.equal(folderNameProblem(" V1", "V1"), "edges");
  assert.equal(folderNameProblem("V1.", "V1"), "edges");
  assert.equal(folderNameProblem("", "V1"), "length");
  assert.equal(folderNameProblem(`V1 ${"x".repeat(120)}`, "V1"), "length");
});

test("BL-261: rewritePaths changes only strings under the old folder", () => {
  assert.deepEqual(rewritePaths({ a: `${FROM}/x.mp4`, b: [`${FROM}/y.jpg`, "other"], c: `${FROM}x`, d: 3, e: FROM }, FROM, TO), { a: `${TO}/x.mp4`, b: [`${TO}/y.jpg`, "other"], c: `${FROM}x`, d: 3, e: TO });
});

test("BL-261: a dry run says what would move and touches nothing", async () => {
  const h = harness();
  const result = await h.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1 Short", dryRun: true });
  assert.deepEqual(result, { dryRun: true, video: "V1", from: FROM, to: TO, uploads: 2, changed: true, readBack: null });
  assert.deepEqual(h.calls, []);
});

test("BL-261: the folder moves, queued and finished rows follow it in one rewrite, read back and audited", async () => {
  const h = harness();
  const result = await h.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1 Short" });
  assert.deepEqual(result, { dryRun: false, video: "V1", from: FROM, to: TO, uploads: 2, changed: true, readBack: "verified" });
  assert.deepEqual(h.calls, ["gate", `rename:${WS}/${FROM}->${WS}/${TO}`, "rewrite:u1,u2", "invalidate", "audit:release_folder.renamed:verified"]);
  for (const r of h.rows()) {
    assert.equal(r.manifestPath, `${TO}/V1_release.json`);
    const pkg = JSON.parse(r.packageJson) as Record<string, string>;
    assert.equal(pkg.manifestPath, `${TO}/V1_release.json`);
    assert.equal(pkg.videoFile, `${TO}/V1 Short.mp4`);
    assert.equal(pkg.thumbnailFile, `${TO}/Thumbnail_V1.jpg`);
    assert.equal(pkg.title, `${FROM} is not a path here`);
  }
});

test("BL-261: refused while busy here, elsewhere or by a cross-post; a taken name; nothing moved", async () => {
  for (const status of ["uploading", "processing", "finishing", "paused"]) {
    const h = harness({}, [row("u1", status)]);
    assert.equal(await codeOf(h.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1 Short" })), "release_folder_busy:upload_here", status);
    assert.deepEqual(h.calls, []);
  }
  const peer = harness({ peerUploads: async () => new Map([["V1", { host: "win-pc", uploaded: false }]]) });
  assert.equal(await codeOf(peer.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1 Short" })), "release_folder_busy:upload_elsewhere");
  // Finished on the other computer: allowed.
  const peerDone = harness({ peerUploads: async () => new Map([["V1", { host: "win-pc", uploaded: true }]]) });
  assert.equal(await codeOf(peerDone.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1 Short", dryRun: true })), "ok");
  const social = harness({ socialBusy: async () => true });
  assert.equal(await codeOf(social.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1 Short" })), "release_folder_busy:cross_post");
  const taken = harness();
  assert.equal(await codeOf(taken.core.rename({ channelId: "UC1", video: "V1", newName: "taken V1" })), "release_folder_target_exists:");
  assert.deepEqual([...peer.calls, ...social.calls, ...taken.calls], []);
});

test("BL-261: not found, several folders, a bad name; the same name is a no-op", async () => {
  const h = harness();
  assert.equal(await codeOf(h.core.rename({ channelId: "UC1", video: "V2", newName: "1115 V2 Short" })), "release_folder_not_found:");
  assert.equal(await codeOf(h.core.rename({ channelId: "UC1", video: "V1", newName: "1115 Short" })), "release_folder_name_invalid:missing_video");
  const two = harness({ scan: async () => ({ status: "ok", packages: [{ video: "V1", folder: FROM }, { video: "V1", folder: `${FROM} copy` }] as never }) });
  assert.equal(await codeOf(two.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1 Short" })), "release_folder_ambiguous:");
  const outside = harness({ scan: async () => ({ status: "ok", packages: [{ video: "V1", folder: "Other/1115 V1" }] as never }) });
  assert.equal(await codeOf(outside.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1 Short" })), "release_folder_not_found:");
  const same = await h.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1" });
  assert.equal(same.changed, false);
  assert.deepEqual(h.calls, []);
});

test("BL-261: a failed row rewrite moves the folder back; the rows still name the old folder", async () => {
  const h = harness({
    rewriteUploads: async () => {
      throw new Error("upload u2 changed while the folder was renamed");
    },
  });
  await assert.rejects(h.core.rename({ channelId: "UC1", video: "V1", newName: "1115 V1 Short" }), /changed while/);
  assert.deepEqual(h.calls, ["gate", `rename:${WS}/${FROM}->${WS}/${TO}`, `rename:${WS}/${TO}->${WS}/${FROM}`, "invalidate"]);
  assert.ok(h.rows().every((r) => r.manifestPath.startsWith(`${FROM}/`)));
});
