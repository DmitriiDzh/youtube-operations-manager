import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import type { StoredPublishingUpload, VideoRecodePlan, VideoRecodeSnapshot } from "@/lib/db";
import { createReleaseRecode, renamedForCode, rewriteManifest, type RecodeVideoList, type ReleaseRecodeDeps, type ReleaseRecodeJournal } from "./release-recode";
import type { ScannedPackage } from "./package-scan";
import type { SlotDecision } from "./slot-decision";

// BL-263 acceptance (docs/roadmap/plans/SHORT_VIDEO_CODE_PLAN.md §6, §10 AC-SC-12..19, 21; ADR 0071 §4; the Operator's file rule of
// 2026-11-16). Expected names, fields and rows are written by hand from the plan: V14 → S12 renames the folder `1105 V14 Short` to
// `1105 S12 Short` and every file named after V14 as a whole token (never V1's or V12's), rewrites only the manifest's `video` and
// file fields and the records' `video`, moves this computer's rows, and changes nothing on a dry run, a refusal or a failure.

const WS = "/ws";
const CH = "UC_wwe";
const MONTH = "04 Videos/11 November";
const FROM = `${MONTH}/1105 V14 Short`;
const TO = `${MONTH}/1105 S12 Short`;
const VIDEO_ID = "6Zt6kYUUMVo";
const BOM = "﻿";
const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const MANIFEST = {
  schema: "yt-release-package/2",
  channelId: CH,
  video: "V14",
  title: "V14 Wonderful World Explained.mp4 -- not a path",
  description: "Thumbnail_V14.jpg stays in the text",
  tags: ["V14"],
  localizations: { ja: { title: "V14", description: "V14_release.json" } },
  files: { video: "V14 Wonderful World Explained.mp4", thumbnail: "Thumbnail_V14.jpg" },
  thumbnails: [
    { file: "Thumbnail_V14.jpg", role: "default" },
    { file: "Thumbnail_V14_A.jpg", role: "test" },
  ],
  sha256: "f".repeat(64),
  slotId: "wwe-v14-s0012",
};
const manifestText = `${BOM}${JSON.stringify(MANIFEST, null, 2)}\n`;
const recordText = `${JSON.stringify({ schema: "yt-release-upload/1", channelId: CH, video: "V14", videoId: VIDEO_ID, uploadedAt: "2026-11-10T00:00:00.000Z", device: { deviceId: "mac" }, result: "uploaded" }, null, 2)}\n`;
const costText = `${JSON.stringify({ schema: "ytm.video-cost", channelId: CH, video: "V14", totals: { totalUsd: 1 }, runs: [] }, null, 2)}\n`;

function initialFiles(): Map<string, string> {
  const f = new Map<string, string>();
  const put = (folder: string, name: string, text = "x") => f.set(`${WS}/${folder}/${name}`, text);
  put(FROM, "V14_release.json", manifestText);
  put(FROM, "V14_youtube.json", recordText);
  put(FROM, "V14_cost.json", costText);
  put(FROM, "V14 Wonderful World Explained.mp4", "mp4");
  put(FROM, "Thumbnail_V14.jpg");
  put(FROM, "Thumbnail_V14_A.jpg");
  put(FROM, "Thumbnail_V14_base.png");
  put(FROM, "Thumbnail_V14_A.logo.json");
  put(FROM, "V14_CrossPost.json");
  put(FROM, "V14_Tags.txt");
  put(FROM, "V14_YouTube_Title_Description.txt");
  put(FROM, "thumb_a.jpg");
  put(FROM, "localizations/ja.json", "{}");
  put(FROM, "work/V14_scratch.txt");
  put(FROM, "work/notes.txt");
  // V1 and V12 of the same channel: never touched by V14's (or V1's) recode.
  put(`${MONTH}/1101 V1 Short`, "V1_release.json", JSON.stringify({ ...MANIFEST, video: "V1", files: { video: "V1 Wonderful World Explained.mp4", thumbnail: "Thumbnail_V1.jpg" }, thumbnails: [] }));
  put(`${MONTH}/1112 V12 Short`, "V12_release.json", JSON.stringify({ ...MANIFEST, video: "V12", files: { video: "V12 Wonderful World Explained.mp4", thumbnail: "Thumbnail_V12.jpg" }, thumbnails: [] }));
  put(`${MONTH}/1104 V4`, "V4_release.json", JSON.stringify({ ...MANIFEST, video: "V4", files: { video: "V4 Wonderful World Explained.mp4", thumbnail: "Thumbnail_V4.jpg" }, thumbnails: [] }));
  return f;
}

const uploadRow = (over: Partial<StoredPublishingUpload> = {}): StoredPublishingUpload =>
  ({
    id: "u14",
    channelId: CH,
    video: "V14",
    status: "done",
    leaseUntil: null,
    videoId: VIDEO_ID,
    manifestPath: `${FROM}/V14_release.json`,
    manifestSha256: sha(manifestText),
    packageJson: JSON.stringify({ video: "V14", title: "t", manifestPath: `${FROM}/V14_release.json`, videoFile: `${FROM}/V14 Wonderful World Explained.mp4`, thumbnailFile: `${FROM}/Thumbnail_V14.jpg` }),
    ...over,
  }) as unknown as StoredPublishingUpload;

type Reservation = { channelId: string; video: string; workingTitle: string | null; state: "in_work" | "cancelled"; replacedBy: string | null };

type Fail = { op: "rename-file" | "write-manifest" | "write-record" | "rename-folder" | "rows" | "storyboard" | "undo"; after?: number };

function harness(options: { uploads?: StoredPublishingUpload[]; frame?: "vertical" | "horizontal" | null; fail?: Fail; slots?: Map<string, SlotDecision>; review?: Map<string, "approved" | "returned">; reviewFails?: boolean | ((call: number) => boolean); peer?: Map<string, { host: string | null; uploaded: boolean }>; files?: Map<string, string>; activeJobs?: number } = {}) {
  const files = options.files ?? initialFiles();
  let uploads = options.uploads ?? [uploadRow()];
  const reservations: Reservation[] = [
    { channelId: CH, video: "V14", workingTitle: "Piece 12", state: "in_work", replacedBy: null },
    { channelId: CH, video: "V26", workingTitle: null, state: "in_work", replacedBy: null },
  ];
  const jobs = [{ id: "j1", channelId: CH, video: "V14" }, { id: "j2", channelId: CH, video: "V12" }, { id: "j3", channelId: "UC_other", video: "V14" }];
  let orientation: Record<string, string> = { V14: "vertical" };
  const storyboards = [{ id: "sb1", video: "V14" }, { id: "sb2", video: "V1" }];
  const journals = new Map<string, ReleaseRecodeJournal>();
  const calls: string[] = [];
  const carries: Array<{ channelId: string; fromSha256: string; toSha256: string; video: string; journals: number; renamedYet: boolean }> = [];
  let failCount = 0;
  let failed = false;
  // The injected failure happens once (the undo that follows works, unless a test breaks it on purpose).
  const maybeFail = (op: Fail["op"]) => {
    if (failed || options.fail?.op !== op) return;
    failCount += 1;
    if (failCount > (options.fail.after ?? 0)) {
      failed = true;
      throw new Error(`injected ${op} failure`);
    }
  };
  const dirsOf = () => {
    const dirs = new Set<string>();
    for (const file of files.keys()) {
      let d = path.posix.dirname(file);
      while (d.length > WS.length) {
        dirs.add(d);
        d = path.posix.dirname(d);
      }
    }
    return dirs;
  };
  const scan = async () => {
    const packages: ScannedPackage[] = [];
    for (const [file, text] of files) {
      const rel = file.slice(WS.length + 1);
      const parts = rel.split("/");
      if (parts.length !== 4 || !/^(V\d+|S[1-9]\d{0,5})_release\.json$/.test(parts[3])) continue;
      const json = JSON.parse(text.replace(/^﻿/, "")) as { video: string; slotId?: string };
      const folder = parts.slice(0, 3).join("/");
      const record = [...files.keys()].find((k) => k === `${WS}/${folder}/${json.video}_youtube.json`);
      packages.push({
        manifestPath: rel,
        folder,
        video: json.video,
        manifestSha256: sha(text),
        orientation: folder === FROM || folder === TO ? (options.frame === undefined ? "vertical" : options.frame) : "vertical",
        youtube: record ? { videoId: JSON.parse(files.get(record)!).videoId, privacyStatus: "public", publishAt: null } : null,
        state: record ? "published" : "not_ready",
        pkg: { slotId: json.slotId },
      } as unknown as ScannedPackage);
    }
    return { status: "ok" as const, packages };
  };
  const videoList = async (): Promise<RecodeVideoList> => {
    const codes = new Map<string, { sources: Set<string>; recodedTo: string | null; youtubeVideoId: string | null }>();
    const at = (code: string) => codes.get(code) ?? (codes.set(code, { sources: new Set(), recodedTo: null, youtubeVideoId: null }), codes.get(code)!);
    for (const r of reservations.filter((x) => x.channelId === CH)) {
      at(r.video).sources.add("reservation");
      if (r.state === "cancelled" && r.replacedBy?.startsWith("S")) at(r.video).recodedTo = r.replacedBy;
    }
    for (const d of dirsOf()) {
      const m = /^\/ws\/04 Videos\/[^/]+\/\d{4} ((?:V|S)\d+)(?: Short)?$/.exec(d);
      if (m) at(m[1]).sources.add("folder");
    }
    for (const u of uploads) {
      at(u.video).sources.add("upload");
      if (u.videoId) at(u.video).youtubeVideoId = u.videoId;
    }
    for (const e of codes.values()) if (e.recodedTo) e.youtubeVideoId = null;
    const vs = [...codes.keys()].filter((c) => c.startsWith("V")).map((c) => Number(c.slice(1)));
    return {
      videos: [...codes].map(([video, e]) => ({ video, state: e.recodedTo ? "recoded" : "in_work", sources: [...e.sources], recodedTo: e.recodedTo, youtubeVideoId: e.youtubeVideoId })),
      nextVideo: `V${Math.max(0, ...vs) + 1}`,
    };
  };
  const deps: ReleaseRecodeDeps = {
    workspace: async (channelId) => (channelId === CH ? WS : null),
    scan: async (channelId) => (channelId === CH ? scan() : { status: "no_workspace" as const }) as never,
    uploads: async () => uploads.map((u) => ({ ...u })),
    peerUploads: async () => options.peer ?? new Map(),
    socialBusy: async () => false,
    livePaths: async () => [],
    activeJobs: async () => options.activeJobs ?? 0,
    videoList: async () => videoList(),
    approvals: async () => ({ slots: options.slots ?? new Map() }),
    // Owner TG 4584: the package-reviews rule is faked here (its own tests cover the copy); this records what was asked, and whether
    // the journal or any file had changed by then.
    async carryReviewDecision(channelId, input) {
      carries.push({ channelId, ...input, journals: journals.size, renamedYet: files.has(`${WS}/${TO}/S12_release.json`) || files.has(`${WS}/${FROM}/S12_release.json`) });
      calls.push("review:carry");
      const failing = typeof options.reviewFails === "function" ? options.reviewFails(carries.length) : options.reviewFails;
      if (failing) throw new Error("review document unreadable");
      return { carried: options.review?.get(input.fromSha256) ?? null };
    },
    peerLinks: async (_c, video) => (video === "V14" ? [{ deviceId: "win", hostName: "WIN-PC", kind: "cost_run" as const, count: 2 }] : []),
    async listFolder(abs) {
      const out = new Map<string, "file" | "dir">();
      for (const file of files.keys()) {
        if (!file.startsWith(`${abs}/`)) continue;
        const [first, ...rest] = file.slice(abs.length + 1).split("/");
        out.set(first, rest.length === 0 ? "file" : "dir");
      }
      return [...out].map(([name, kind]) => ({ name, kind }));
    },
    readText: async (abs) => {
      const text = files.get(abs);
      if (text === undefined) throw new Error(`ENOENT ${abs}`);
      return text;
    },
    async writeText(abs, text) {
      maybeFail(abs.endsWith("_release.json") ? "write-manifest" : "write-record");
      calls.push(`write:${abs.slice(WS.length + 1)}`);
      files.set(abs, text);
    },
    exists: async (abs) => files.has(abs) || dirsOf().has(abs),
    isRealFolder: async (_ws, rel) => dirsOf().has(`${WS}/${rel}`),
    async rename(from, to) {
      const isDir = dirsOf().has(from);
      maybeFail(isDir ? "rename-folder" : "rename-file");
      calls.push(`rename:${from.slice(WS.length + 1)}->${to.slice(WS.length + 1)}`);
      if (isDir) {
        for (const [k, v] of [...files]) {
          if (k.startsWith(`${from}/`)) {
            files.delete(k);
            files.set(`${to}${k.slice(from.length)}`, v);
          }
        }
      } else {
        const v = files.get(from);
        if (v === undefined) throw new Error(`ENOENT ${from}`);
        files.delete(from);
        files.set(to, v);
      }
    },
    rows: {
      async snapshot(channelId, from, to, ids): Promise<VideoRecodeSnapshot> {
        const res = reservations.find((r) => r.channelId === channelId && r.video === from);
        return {
          channelId,
          from,
          to,
          uploads: uploads.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, video: u.video, manifestPath: u.manifestPath, manifestSha256: u.manifestSha256, packageJson: u.packageJson, videoId: u.videoId ?? null })),
          reservation: res ? { workingTitle: res.workingTitle, reservedAt: "2026-10-01T00:00:00.000Z", state: res.state, cancelledAt: null, replacedBy: res.replacedBy } : null,
          mediaJobs: jobs.filter((j) => j.channelId === channelId && j.video === from).map((j) => j.id),
          geminiJobs: [],
          speechJobs: [],
          plans: [],
          socialJobs: [],
          orientation: (orientation[from] as "vertical" | undefined) ?? null,
        };
      },
      async recode(snapshot: VideoRecodeSnapshot, plan: VideoRecodePlan) {
        maybeFail("rows");
        calls.push("rows:recode");
        uploads = uploads.map((u) => {
          const p = plan.uploads.find((x) => x.id === u.id);
          return p ? ({ ...u, video: snapshot.to, manifestPath: p.manifestPath, manifestSha256: p.manifestSha256, packageJson: p.packageJson } as StoredPublishingUpload) : u;
        });
        const res = reservations.find((r) => r.channelId === snapshot.channelId && r.video === snapshot.from);
        if (res) Object.assign(res, { state: "cancelled", replacedBy: snapshot.to });
        reservations.push({ channelId: snapshot.channelId, video: snapshot.to, workingTitle: snapshot.reservation?.workingTitle ?? null, state: "in_work", replacedBy: null });
        for (const j of jobs) if (snapshot.mediaJobs.includes(j.id)) j.video = snapshot.to;
        if (snapshot.orientation) orientation = Object.fromEntries(Object.entries(orientation).map(([k, v]) => [k === snapshot.from ? snapshot.to : k, v]));
      },
      async undo(snapshot: VideoRecodeSnapshot) {
        maybeFail("undo");
        calls.push("rows:undo");
        uploads = uploads.map((u) => {
          const b = snapshot.uploads.find((x) => x.id === u.id);
          return b && u.video === snapshot.to ? ({ ...u, video: b.video, manifestPath: b.manifestPath, manifestSha256: b.manifestSha256, packageJson: b.packageJson } as StoredPublishingUpload) : u;
        });
        const i = reservations.findIndex((r) => r.video === snapshot.to && r.state === "in_work");
        if (i >= 0) reservations.splice(i, 1);
        const res = reservations.find((r) => r.video === snapshot.from && r.replacedBy === snapshot.to);
        if (res && snapshot.reservation) Object.assign(res, { state: snapshot.reservation.state, replacedBy: snapshot.reservation.replacedBy });
        for (const j of jobs) if (snapshot.mediaJobs.includes(j.id) && j.video === snapshot.to) j.video = snapshot.from;
        if (orientation[snapshot.to] && !orientation[snapshot.from]) orientation = Object.fromEntries(Object.entries(orientation).map(([k, v]) => [k === snapshot.to ? snapshot.from : k, v]));
      },
    },
    storyboards: {
      linked: async (_c, video) => storyboards.filter((s) => s.video === video).map((s) => s.id),
      async setVideo(_c, id, video) {
        maybeFail("storyboard");
        storyboards.find((s) => s.id === id)!.video = video;
      },
    },
    journal: {
      pathFor: (channelId, video, at) => `/app/release-recode/${channelId}/${video}-${at.getTime()}.json`,
      write: async (p, j) => void journals.set(p, structuredClone(j)),
      list: async (channelId) => [...journals.keys()].filter((k) => k.startsWith(`/app/release-recode/${channelId}/`)),
      read: async (p) => structuredClone(journals.get(p)!),
      remove: async (p) => void journals.delete(p),
    },
    publishReports: async () => void calls.push("reports"),
    assertMutationAllowed: async () => void calls.push("gate"),
    audit: async (entry) => void calls.push(`audit:${entry.detail.event}${entry.detail.readBack ? `:${entry.detail.readBack}` : ""}`),
    invalidate: () => void calls.push("invalidate"),
    now: () => new Date("2026-11-16T12:00:00.000Z"),
    join: (...parts) => parts.join("/"),
  };
  const state = () => ({
    files: new Map(files),
    uploads: structuredClone(uploads),
    reservations: structuredClone(reservations),
    jobs: structuredClone(jobs),
    orientation: { ...orientation },
    storyboards: structuredClone(storyboards),
  });
  return { core: createReleaseRecode(deps), deps, files, calls, carries, journals, state, uploads: () => uploads, reservations, storyboards, jobs, orientation: () => orientation };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (isDomainError(e) ? `${e.code}${(e.details as { reason?: string; field?: string; step?: string })?.reason ? `:${(e.details as { reason: string }).reason}` : ""}` : `thrown:${String(e)}`)
  );

// -- The Operator's file rule.
test("BL-263: the files named after a code -- at the start or in a thumbnail -- as a whole token: V1 never matches V12's files", () => {
  assert.equal(renamedForCode("V14_release.json", "V14", "S12"), "S12_release.json");
  assert.equal(renamedForCode("V14_YouTube_Title_Description.txt", "V14", "S12"), "S12_YouTube_Title_Description.txt");
  assert.equal(renamedForCode("V14 Wonderful World Explained.mp4", "V14", "S12"), "S12 Wonderful World Explained.mp4");
  assert.equal(renamedForCode("Thumbnail_V14.jpg", "V14", "S12"), "Thumbnail_S12.jpg");
  assert.equal(renamedForCode("Thumbnail_V14_A.png", "V14", "S12"), "Thumbnail_S12_A.png");
  assert.equal(renamedForCode("Thumbnail_V14_base.jpeg", "V14", "S12"), "Thumbnail_S12_base.jpeg");
  assert.equal(renamedForCode("Thumbnail_V14_A.logo.json", "V14", "S12"), "Thumbnail_S12_A.logo.json");
  // V1 against V12's files (and the other way round): never.
  for (const name of ["V12_release.json", "V12 WWE.mp4", "Thumbnail_V12.jpg", "Thumbnail_V12_A.jpg", "V12.srt", "V1x.txt", "V10_cost.json"]) assert.equal(renamedForCode(name, "V1", "S1"), null, name);
  assert.equal(renamedForCode("V1_release.json", "V12", "S10"), null);
  assert.equal(renamedForCode("Thumbnail_V1.jpg", "V12", "S10"), null);
  assert.equal(renamedForCode("V1_release.json", "V1", "S1"), "S1_release.json");
  assert.equal(renamedForCode("V1 WWE.mp4", "V1", "S1"), "S1 WWE.mp4");
  assert.equal(renamedForCode("Thumbnail_V1.jpg", "V1", "S1"), "Thumbnail_S1.jpg");
  // Not named after the code.
  for (const name of ["thumb_a.jpg", "ja.json", "Thumbnail_V14_AB.jpg", "Thumbnail_V14.gif", "XV14_release.json", "V14"]) assert.equal(renamedForCode(name, "V14", "S12"), null, name);
});

test("BL-263: the manifest -- video and every file field follow; title, description, tags and localizations stay byte-identical", () => {
  const renames = new Map([
    ["V14 Wonderful World Explained.mp4", "S12 Wonderful World Explained.mp4"],
    ["Thumbnail_V14.jpg", "Thumbnail_S12.jpg"],
    ["Thumbnail_V14_A.jpg", "Thumbnail_S12_A.jpg"],
  ]);
  const { manifest, fields } = rewriteManifest(structuredClone(MANIFEST), "S12", renames);
  assert.deepEqual(fields, ["video", "files.video", "files.thumbnail", "thumbnails[0].file", "thumbnails[1].file"]);
  assert.deepEqual(manifest, {
    ...MANIFEST,
    video: "S12",
    files: { video: "S12 Wonderful World Explained.mp4", thumbnail: "Thumbnail_S12.jpg" },
    thumbnails: [
      { file: "Thumbnail_S12.jpg", role: "default" },
      { file: "Thumbnail_S12_A.jpg", role: "test" },
    ],
  });
  assert.equal(JSON.stringify(manifest.localizations), JSON.stringify(MANIFEST.localizations));
  assert.equal(manifest.title, MANIFEST.title);
  assert.equal(manifest.description, MANIFEST.description);
});

const EXPECTED_FILES = [
  { from: "Thumbnail_V14.jpg", to: "Thumbnail_S12.jpg" },
  { from: "Thumbnail_V14_A.jpg", to: "Thumbnail_S12_A.jpg" },
  { from: "Thumbnail_V14_A.logo.json", to: "Thumbnail_S12_A.logo.json" },
  { from: "Thumbnail_V14_base.png", to: "Thumbnail_S12_base.png" },
  { from: "V14 Wonderful World Explained.mp4", to: "S12 Wonderful World Explained.mp4" },
  { from: "V14_CrossPost.json", to: "S12_CrossPost.json" },
  { from: "V14_Tags.txt", to: "S12_Tags.txt" },
  { from: "V14_YouTube_Title_Description.txt", to: "S12_YouTube_Title_Description.txt" },
  { from: "V14_cost.json", to: "S12_cost.json" },
  { from: "V14_release.json", to: "S12_release.json" },
  { from: "V14_youtube.json", to: "S12_youtube.json" },
  { from: "work/V14_scratch.txt", to: "work/S12_scratch.txt" },
];

test("BL-263 AC-SC-12: the dry run of V14→S12 changes nothing and lists the folder, files, manifest fields, both hashes, rows and peer links", async () => {
  const h = harness();
  const before = h.state();
  const result = await h.core.recode({ channelId: CH, video: "V14", newCode: "S12", dryRun: true });
  assert.deepEqual(h.state(), before, "files, rows, storyboards and memo byte-identical");
  assert.equal(h.journals.size, 0);
  assert.deepEqual(h.calls, [], "no gate, no write, no report, no audit");
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, false);
  assert.equal(result.from, FROM);
  assert.equal(result.to, TO);
  assert.deepEqual(result.files, EXPECTED_FILES);
  assert.deepEqual(result.manifest.fields, ["video", "files.video", "files.thumbnail", "thumbnails[0].file", "thumbnails[1].file"]);
  assert.equal(result.manifest.oldSha256, sha(manifestText));
  const expectedNew = `${BOM}${JSON.stringify({ ...MANIFEST, video: "S12", files: { video: "S12 Wonderful World Explained.mp4", thumbnail: "Thumbnail_S12.jpg" }, thumbnails: [{ file: "Thumbnail_S12.jpg", role: "default" }, { file: "Thumbnail_S12_A.jpg", role: "test" }] }, null, 2)}\n`;
  assert.equal(result.manifest.newSha256, sha(expectedNew));
  assert.deepEqual(result.records, { youtube: true, cost: true });
  assert.deepEqual(result.rows, { uploads: 1, reservations: 2, jobs: 1, plans: 0, storyboards: 1, socialJobs: 0, orientation: 1 });
  assert.deepEqual(result.peerLinks, [{ deviceId: "win", hostName: "WIN-PC", kind: "cost_run", count: 2 }]);
  assert.equal(result.frame, "vertical");
  assert.equal(result.readBack, null);
});

test("BL-263 AC-SC-13/14: the real V14→S12 -- folder, files, manifest, records, rows, storyboards and memo move; read-back verified", async () => {
  const h = harness();
  const dry = await h.core.recode({ channelId: CH, video: "V14", newCode: "S12", dryRun: true });
  const result = await h.core.recode({ channelId: CH, video: "V14", newCode: "S12" });
  assert.equal(result.changed, true);
  assert.equal(result.readBack, "verified");
  assert.equal(result.manifest.newSha256, dry.manifest.newSha256, "the dry run said exactly what happened");
  // Folder and files.
  assert.equal([...h.files.keys()].some((k) => k.startsWith(`${WS}/${FROM}/`)), false, "the old folder is gone");
  for (const f of EXPECTED_FILES) assert.ok(h.files.has(`${WS}/${TO}/${f.to}`), f.to);
  for (const kept of ["thumb_a.jpg", "localizations/ja.json", "work/notes.txt"]) assert.ok(h.files.has(`${WS}/${TO}/${kept}`), kept);
  // V1, V12 and V4 untouched.
  for (const k of ["1101 V1 Short/V1_release.json", "1112 V12 Short/V12_release.json", "1104 V4/V4_release.json"]) assert.ok(h.files.has(`${WS}/${MONTH}/${k}`), k);
  // Manifest: video and file fields; free text byte-identical; the BOM kept.
  const manifest = h.files.get(`${WS}/${TO}/S12_release.json`)!;
  assert.ok(manifest.startsWith(BOM));
  const parsed = JSON.parse(manifest.slice(1));
  assert.equal(parsed.video, "S12");
  assert.deepEqual(parsed.files, { video: "S12 Wonderful World Explained.mp4", thumbnail: "Thumbnail_S12.jpg" });
  for (const key of ["title", "description", "tags", "localizations", "sha256", "slotId"]) assert.equal(JSON.stringify(parsed[key]), JSON.stringify((MANIFEST as Record<string, unknown>)[key]), key);
  assert.equal(sha(manifest), result.manifest.newSha256);
  // Records: only `video`.
  const record = JSON.parse(h.files.get(`${WS}/${TO}/S12_youtube.json`)!);
  assert.deepEqual(record, { ...JSON.parse(recordText), video: "S12" });
  assert.equal(record.videoId, VIDEO_ID);
  assert.deepEqual(JSON.parse(h.files.get(`${WS}/${TO}/S12_cost.json`)!), { ...JSON.parse(costText), video: "S12" });
  // The upload row: S12, the new manifest path and hash, the same video id; the package paths follow, its title stays.
  const [row] = h.uploads();
  assert.deepEqual([row.video, row.manifestPath, row.manifestSha256, row.videoId], ["S12", `${TO}/S12_release.json`, result.manifest.newSha256, VIDEO_ID]);
  assert.deepEqual(JSON.parse(row.packageJson), { video: "S12", title: "t", manifestPath: `${TO}/S12_release.json`, videoFile: `${TO}/S12 Wonderful World Explained.mp4`, thumbnailFile: `${TO}/Thumbnail_S12.jpg` });
  // Reservations, jobs, storyboards, memo.
  assert.deepEqual(h.reservations.filter((r) => r.video === "V14" || r.video === "S12"), [
    { channelId: CH, video: "V14", workingTitle: "Piece 12", state: "cancelled", replacedBy: "S12" },
    { channelId: CH, video: "S12", workingTitle: "Piece 12", state: "in_work", replacedBy: null },
  ]);
  assert.deepEqual(h.jobs.map((j) => [j.id, j.video]), [["j1", "S12"], ["j2", "V12"], ["j3", "V14"]], "another channel's job is never touched");
  assert.deepEqual(h.storyboards, [{ id: "sb1", video: "S12" }, { id: "sb2", video: "V1" }]);
  assert.deepEqual(h.orientation(), { S12: "vertical" });
  // Order: gate, files, manifest, records, folder, rows; reports and audit after; the journal removed.
  assert.equal(h.calls[0], "gate");
  assert.ok(h.calls.indexOf("write:" + `${FROM}/S12_release.json`) < h.calls.indexOf(`rename:${FROM}->${TO}`));
  assert.ok(h.calls.indexOf(`rename:${FROM}->${TO}`) < h.calls.indexOf("rows:recode"));
  assert.ok(h.calls.includes("reports"));
  assert.equal(h.calls.at(-1), "audit:release.recoded:verified");
  assert.equal(h.journals.size, 0);
});

test("BL-263 AC-SC-15: after the recode the next V is the same as before (V27 with V26 the highest) and V14 lists as recoded → S12", async () => {
  const h = harness();
  const before = await h.deps.videoList(CH);
  await h.core.recode({ channelId: CH, video: "V14", newCode: "S12" });
  const after = await h.deps.videoList(CH);
  assert.equal(before.nextVideo, "V27");
  assert.equal(after.nextVideo, "V27");
  const v14 = after.videos.find((v) => v.video === "V14")!;
  assert.deepEqual([v14.state, v14.recodedTo, v14.youtubeVideoId], ["recoded", "S12", null]);
  assert.equal(after.videos.find((v) => v.video === "S12")!.youtubeVideoId, VIDEO_ID);
});

test("BL-263 AC-SC-16: V4 (no « Short»), a horizontal Short, a known S12, another channel, S5 as video or V5 as newCode are refused; nothing changes", async () => {
  const h = harness();
  h.files.set(`${WS}/${MONTH}/1104 V4/V4_youtube.json`, recordText.replace("V14", "V4"));
  const before = h.state();
  assert.equal(await codeOf(h.core.recode({ channelId: CH, video: "V4", newCode: "S30" })), "release_recode_not_short:folder");
  assert.equal(await codeOf(harness({ frame: "horizontal" }).core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_not_short:horizontal");
  assert.equal(await codeOf(h.core.recode({ channelId: CH, video: "V14", newCode: "S26", dryRun: true })), "ok", "an unknown S is fine");
  assert.deepEqual(h.state(), before);
  const h2 = harness();
  h2.reservations.push({ channelId: CH, video: "S12", workingTitle: null, state: "cancelled", replacedBy: null });
  assert.equal(await codeOf(h2.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_target_exists");
  const h3 = harness();
  h3.files.set(`${WS}/${MONTH}/1120 S12 Short/x.txt`, "x");
  assert.equal(await codeOf(h3.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_target_exists");
  const h4 = harness();
  h4.files.set(`${WS}/${FROM}/Thumbnail_S12.jpg`, "already");
  assert.equal(await codeOf(h4.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_target_exists");
  const h5 = harness({ peer: new Map([["S12", { host: "WIN-PC", uploaded: true }]]) });
  assert.equal(await codeOf(h5.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_target_exists");
  const h6 = harness();
  assert.equal(await codeOf(h6.core.recode({ channelId: "UC_other", video: "V14", newCode: "S12" })), "release_recode_not_found");
  assert.equal(await codeOf(h6.core.recode({ channelId: CH, video: "V99", newCode: "S12" })), "release_recode_not_found");
  assert.equal(await codeOf(h6.core.recode({ channelId: CH, video: "S5", newCode: "S12" })), "release_recode_invalid");
  assert.equal(await codeOf(h6.core.recode({ channelId: CH, video: "V14", newCode: "V5" })), "release_recode_invalid");
  for (const bad of ["S0", "S014", "s12", "S1000000"]) assert.equal(await codeOf(h6.core.recode({ channelId: CH, video: "V14", newCode: bad })), "release_recode_invalid", bad);
  for (const x of [h2, h3, h4, h5, h6]) assert.deepEqual(x.calls, [], "a refusal changes nothing");
});

test("BL-263 AC-SC-17: refused while uploading here (also a leased queued row), a peer upload row, a cross-post, a live rotation, a standing approval", async () => {
  for (const status of ["uploading", "processing", "finishing", "paused"]) {
    assert.equal(await codeOf(harness({ uploads: [uploadRow({ status: status as never })] }).core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_busy:upload_here", status);
  }
  const leased = harness({ uploads: [uploadRow({ status: "queued" as never, videoId: null, leaseUntil: new Date("2026-11-16T12:05:00.000Z") as never })] });
  assert.equal(await codeOf(leased.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_busy:upload_here");
  const peer = harness({ peer: new Map([["V14", { host: "WIN-PC", uploaded: true }]]) });
  assert.equal(await codeOf(peer.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_elsewhere");
  const social = harness();
  social.deps.socialBusy = async () => true;
  assert.equal(await codeOf(createReleaseRecode(social.deps).recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_busy:cross_post");
  const live = harness();
  live.deps.livePaths = async () => [`${FROM}/V14 Wonderful World Explained.mp4`];
  assert.equal(await codeOf(createReleaseRecode(live.deps).recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_busy:live_rotation");

  // Approvals. Not uploaded (no record, no done row): an approved slot naming it. A package-review approval is no longer a refusal
  // (requirement changed, owner TG 4584: the owner's decision is carried to the new manifest -- see the carry tests below).
  const unpublished = () => {
    const files = initialFiles();
    files.delete(`${WS}/${FROM}/V14_youtube.json`);
    return files;
  };
  const sha14 = sha(manifestText);
  const slotApproved = new Map<string, SlotDecision>([["wwe-v14-s0012", { kind: "approved", publishAt: "2026-11-20T10:00:00.000Z", package: { video: "V14", manifestSha256: sha14, videoId: null } }]]);
  assert.equal(await codeOf(harness({ files: unpublished(), uploads: [], slots: slotApproved }).core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_approval_standing:plan_slot");
  // Uploaded and the slot approval counts, but the video has no date yet (private): the plan would still date it.
  const privateFiles = initialFiles();
  const privateHarness = harness({ files: privateFiles, slots: new Map([["wwe-v14-s0012", { kind: "approved", publishAt: "2026-11-20T10:00:00.000Z", package: { video: "V14", manifestSha256: sha14, videoId: VIDEO_ID } }]]) });
  const realScan = privateHarness.deps.scan;
  privateHarness.deps.scan = async (c) => {
    const r = await realScan(c);
    return r.status === "ok" ? { ...r, packages: r.packages.map((p) => (p.video === "V14" ? { ...p, state: "uploaded_private" as const } : p)) } : r;
  };
  assert.equal(await codeOf(createReleaseRecode(privateHarness.deps).recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_approval_standing:plan_slot_date");
  // Published with an approved slot (released): history -- not a refusal; a pending review of an uploaded package neither.
  const released = harness({ slots: new Map([["wwe-v14-s0012", { kind: "approved", publishAt: "2026-11-10T10:00:00.000Z", package: { video: "V14", manifestSha256: sha14, videoId: VIDEO_ID } }]]), review: new Map([[sha14, "approved"]]) });
  assert.equal(await codeOf(released.core.recode({ channelId: CH, video: "V14", newCode: "S12", dryRun: true })), "ok");
});

const STEP_FAILURES: Array<{ fail: Fail; step: string }> = [
  { fail: { op: "rename-file", after: 3 }, step: "files" },
  { fail: { op: "write-manifest" }, step: "manifest" },
  { fail: { op: "write-record", after: 1 }, step: "records" },
  { fail: { op: "rename-folder" }, step: "folder" },
  { fail: { op: "rows" }, step: "rows" },
  { fail: { op: "storyboard" }, step: "storyboards" },
];

for (const { fail, step } of STEP_FAILURES) {
  test(`BL-263 AC-SC-18: a failure at ${step} leaves folder, files, rows, storyboards and memo exactly as before; release_recode_busy step ${step}`, async () => {
    const h = harness({ fail });
    const before = h.state();
    await assert.rejects(h.core.recode({ channelId: CH, video: "V14", newCode: "S12" }), (e: unknown) => isDomainError(e) && e.code === "release_recode_busy" && (e.details as { step?: string }).step === step);
    assert.deepEqual(h.state(), before);
    assert.equal(h.journals.size, 0, "the journal is removed after a complete undo");
    assert.ok(h.calls.includes("audit:release.recode_failed"));
  });
}

test("BL-263 AC-SC-18: a failed undo answers release_recode_rollback_failed with the journal path, and the journal stays", async () => {
  const h = harness({ fail: { op: "storyboard" } });
  // The undo of the rows fails too.
  const undo = h.deps.rows.undo;
  h.deps.rows.undo = async () => {
    throw new Error("database locked");
  };
  void undo;
  const error = await createReleaseRecode(h.deps)
    .recode({ channelId: CH, video: "V14", newCode: "S12" })
    .then(() => null, (e: unknown) => e);
  assert.ok(isDomainError(error) && error.code === "release_recode_rollback_failed");
  const journalPath = (error.details as { journal: string }).journal;
  assert.equal(journalPath, `/app/release-recode/${CH}/V14-${Date.parse("2026-11-16T12:00:00.000Z")}.json`);
  assert.ok(h.journals.has(journalPath));
});

test("BL-263 AC-SC-19: a crash after the folder step leaves the journal; the next call restores the original state, reports recoveredFrom, then runs", async () => {
  const h = harness();
  const before = h.state();
  // Simulate the crash: the process dies right after the folder rename (the journal says files, manifest, records, folder done).
  // The rows step dies and its undo cannot run either: the journal is left with files, manifest, records and folder done -- the state a
  // process killed right after the folder rename leaves behind.
  const crashing = {
    ...h.deps,
    rows: {
      ...h.deps.rows,
      recode: async () => {
        throw new Error("process killed");
      },
      undo: async () => {
        throw new Error("the process is gone");
      },
    },
  };
  await createReleaseRecode(crashing).recode({ channelId: CH, video: "V14", newCode: "S12" }).catch(() => undefined);
  assert.equal(h.journals.size, 1, "the journal is left behind");
  const [journal] = [...h.journals.values()];
  assert.deepEqual(journal.done, ["files", "manifest", "records", "folder"]);
  assert.ok([...h.files.keys()].some((k) => k.startsWith(`${WS}/${TO}/`)), "the folder had moved");
  // A dry run never recovers (it changes nothing) ...
  const dryState = h.state();
  await h.core.recode({ channelId: CH, video: "V14", newCode: "S12", dryRun: true }).catch(() => undefined);
  assert.deepEqual(h.state(), dryState);
  // ... the next real call restores first, then runs as new.
  const result = await h.core.recode({ channelId: CH, video: "V14", newCode: "S12" });
  assert.equal(result.recoveredFrom, [...h.journals.keys()][0] ?? journalPathOf(journal));
  assert.equal(result.readBack, "verified");
  assert.equal(h.journals.size, 0);
  // Recovery alone (on a fresh harness, the following scan failing) gives back exactly the original state.
  const h2 = harness();
  const crashing2 = {
    ...h2.deps,
    rows: {
      ...h2.deps.rows,
      recode: async () => {
        throw new Error("killed");
      },
      undo: async () => {
        throw new Error("gone");
      },
    },
  };
  await createReleaseRecode(crashing2).recode({ channelId: CH, video: "V14", newCode: "S12" }).catch(() => undefined);
  const recovering = { ...h2.deps, scan: async () => ({ status: "unavailable" as const }) as never };
  await createReleaseRecode(recovering).recode({ channelId: CH, video: "V14", newCode: "S12" }).catch(() => undefined);
  assert.deepEqual(h2.state(), before, "the journal's backups restored every file name, text and row");
  assert.equal(h2.journals.size, 0);
});

function journalPathOf(journal: ReleaseRecodeJournal): string {
  return `/app/release-recode/${journal.channelId}/${journal.video}-${Date.parse(journal.startedAt)}.json`;
}

// -- AC-SC-21 / AC-SC-14: only the Factory endpoint has the tool; the recode module reaches no YouTube client.
test("BL-263 AC-SC-21: factory_release_recode is a Factory tool only -- no channel worker, Producer or Web route has it", async () => {
  const { WORKER_FACTORY_TOOLS } = await import("@/mcp/worker-factory-tools");
  assert.equal(WORKER_FACTORY_TOOLS.factory_release_recode, undefined);
  const { FACTORY_TOOL_NAMES } = await import("@/mcp/factory-server");
  assert.ok((FACTORY_TOOL_NAMES as readonly string[]).includes("factory_release_recode"));
  const producer = await readFile(path.join(process.cwd(), "src/mcp/producer-tools.ts"), "utf8");
  const server = await readFile(path.join(process.cwd(), "src/mcp/server.ts"), "utf8");
  assert.equal(/release_recode|recodeRelease/.test(producer + server), false);
  const offenders: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") && /release-recode|recodeRelease|createReleaseRecodeCore/.test(await readFile(full, "utf8"))) offenders.push(full);
    }
  }
  await walk(path.join(process.cwd(), "src/app"));
  assert.deepEqual(offenders, []);
});

test("BL-263 AC-SC-14: the recode module and its composition import no YouTube gateway or Google client", async () => {
  for (const file of ["src/lib/publishing/release-recode.ts", "src/composition/release-recode.ts"]) {
    const text = await readFile(path.join(process.cwd(), file), "utf8");
    assert.equal(/youtube-(read|write)-gateway|googleapis|adapters\/youtube-writes/.test(text), false, file);
  }
});

test("BL-263 AC-SC-16: a manifest or record naming another channel is refused release_recode_not_found (channel_mismatch); nothing changes", async () => {
  const files = initialFiles();
  files.set(`${WS}/${FROM}/V14_release.json`, manifestText.replace(`"channelId": "${CH}"`, `"channelId": "UC_other"`));
  const h = harness({ files });
  assert.equal(await codeOf(h.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_not_found:channel_mismatch");
  const files2 = initialFiles();
  files2.set(`${WS}/${FROM}/V14_youtube.json`, recordText.replace(`"channelId": "${CH}"`, `"channelId": "UC_other"`));
  const h2 = harness({ files: files2 });
  assert.equal(await codeOf(h2.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_not_found:channel_mismatch");
  assert.deepEqual([...h.calls, ...h2.calls], []);
});

test("BL-263 AC-SC-19: a journal whose workspace cannot be seen (every file check false) is not reported recovered -- rollback_failed, journal kept", async () => {
  const h = harness();
  const crashing = {
    ...h.deps,
    rows: {
      ...h.deps.rows,
      recode: async () => {
        throw new Error("killed");
      },
      undo: async () => {
        throw new Error("gone");
      },
    },
  };
  await createReleaseRecode(crashing).recode({ channelId: CH, video: "V14", newCode: "S12" }).catch(() => undefined);
  assert.equal(h.journals.size, 1);
  // The drive is not mounted: nothing can be seen or renamed.
  const blind = { ...h.deps, exists: async () => false };
  const error = await createReleaseRecode(blind)
    .recode({ channelId: CH, video: "V14", newCode: "S12" })
    .then(() => null, (e: unknown) => e);
  assert.ok(isDomainError(error) && error.code === "release_recode_rollback_failed", String(error));
  assert.equal(h.journals.size, 1, "the journal stays for a manual restore");
});

// -- Review fixes (2026-11-16).
test("BL-263 review HIGH 1: a finished recode whose journal could not be removed is never undone -- cleared with an audit, not recovered", async () => {
  const h = harness();
  const keep = { ...h.deps, journal: { ...h.deps.journal, remove: async () => { throw new Error("EBUSY"); } } };
  const result = await createReleaseRecode(keep).recode({ channelId: CH, video: "V14", newCode: "S12" });
  assert.equal(result.readBack, "verified");
  assert.deepEqual(result.warnings, [`journal_not_removed: /app/release-recode/${CH}/V14-${Date.parse("2026-11-16T12:00:00.000Z")}.json`]);
  assert.equal(h.journals.size, 1);
  const [journal] = [...h.journals.values()];
  assert.equal(journal.completed, true);
  const done = h.state();
  // The next real call (any video of the channel) clears it and undoes nothing.
  assert.equal(await codeOf(h.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_not_found", "V14 is S12 now");
  assert.equal(h.journals.size, 0);
  assert.deepEqual(h.state(), done, "the recode stands");
  assert.ok(h.calls.includes("audit:release_recode.journal_cleared"));
  assert.equal(h.calls.includes("rows:undo"), false);
});

test("BL-263 review HIGH 1: a journal with every step done but no completed flag (the process died before writing it) is not undone either", async () => {
  const h = harness();
  const keep = { ...h.deps, journal: { ...h.deps.journal, remove: async () => { throw new Error("killed"); } } };
  await createReleaseRecode(keep).recode({ channelId: CH, video: "V14", newCode: "S12" });
  const [path] = [...h.journals.keys()];
  const journal = h.journals.get(path)!;
  delete journal.completed;
  assert.deepEqual(journal.done, ["files", "manifest", "records", "folder", "rows", "storyboards"]);
  const done = h.state();
  // A dry run is not refused by it (finished), and the next real call clears it.
  assert.equal(await codeOf(h.core.recode({ channelId: CH, video: "V14", newCode: "S12", dryRun: true })), "release_recode_not_found");
  await h.core.recode({ channelId: CH, video: "V14", newCode: "S12" }).catch(() => undefined);
  assert.equal(h.journals.size, 0);
  assert.deepEqual(h.state(), done);
});

test("BL-263 review MEDIUM 2: while an unfinished journal exists a dry run is refused release_recode_busy recovery_pending; the real call recovers", async () => {
  const h = harness();
  const crashing = { ...h.deps, rows: { ...h.deps.rows, recode: async () => { throw new Error("killed"); }, undo: async () => { throw new Error("gone"); } } };
  await createReleaseRecode(crashing).recode({ channelId: CH, video: "V14", newCode: "S12" }).catch(() => undefined);
  const error = await h.core.recode({ channelId: CH, video: "V14", newCode: "S12", dryRun: true }).then(() => null, (e: unknown) => e);
  assert.ok(isDomainError(error) && error.code === "release_recode_busy" && (error.details as { reason: string }).reason === "recovery_pending");
  assert.equal((error.details as { journal: string }).journal, [...h.journals.keys()][0]);
  const result = await h.core.recode({ channelId: CH, video: "V14", newCode: "S12" });
  assert.ok(result.recoveredFrom);
  assert.equal(result.readBack, "verified");
});

test("BL-263 review LOW 4/5: a queued upload row of the code (not leased) or an unfinished linked job refuses the recode", async () => {
  const queued = harness({ uploads: [uploadRow({ status: "queued" as never, videoId: null })] });
  assert.equal(await codeOf(queued.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_busy:upload_queued");
  const jobs = harness({ activeJobs: 1 });
  assert.equal(await codeOf(jobs.core.recode({ channelId: CH, video: "V14", newCode: "S12", dryRun: true })), "release_recode_busy:job_running");
  assert.deepEqual([...queued.calls, ...jobs.calls], []);
});

test("BL-263 review LOW 7: a read-back that fails says mismatch with the failed checks", async () => {
  const h = harness();
  let calls = 0;
  const realList = h.deps.videoList;
  const flaky = { ...h.deps, videoList: async (c: string) => (++calls > 1 ? Promise.reject(new Error("list unreadable")) : realList(c)) };
  const result = await createReleaseRecode(flaky).recode({ channelId: CH, video: "V14", newCode: "S12" });
  assert.equal(result.readBack, "mismatch");
  assert.deepEqual(result.readBackProblems, ["video_list"]);
  assert.ok(h.calls.includes("audit:release.recoded:mismatch"));
});

// -- Owner TG 4584 («проверь чтобы те видео что проверял недавно не сбились, не потерялась связь к чему относились замечания»): the
// owner's package-review decision follows the recoded package. Expected hashes are written by hand from the manifest text (§L).
const EXPECTED_NEW_MANIFEST = `${BOM}${JSON.stringify({ ...MANIFEST, video: "S12", files: { video: "S12 Wonderful World Explained.mp4", thumbnail: "Thumbnail_S12.jpg" }, thumbnails: [{ file: "Thumbnail_S12.jpg", role: "default" }, { file: "Thumbnail_S12_A.jpg", role: "test" }] }, null, 2)}\n`;
const unpublishedFiles = () => {
  const files = initialFiles();
  files.delete(`${WS}/${FROM}/V14_youtube.json`);
  return files;
};

test("BL-263 fix (owner TG 4584): an approved, not uploaded Short is recoded, not refused; the approval is carried old → new manifest before any change", async () => {
  const h = harness({ files: unpublishedFiles(), uploads: [], review: new Map([[sha(manifestText), "approved"]]) });
  const result = await h.core.recode({ channelId: CH, video: "V14", newCode: "S12" });
  assert.equal(result.readBack, "verified");
  assert.deepEqual(result.review, { carried: "approved" });
  assert.deepEqual(h.carries[0], { channelId: CH, fromSha256: sha(manifestText), toSha256: sha(EXPECTED_NEW_MANIFEST), video: "S12", journals: 0, renamedYet: false });
  // After the device gate, before the first rename or write.
  assert.equal(h.calls[0], "gate");
  assert.equal(h.calls[1], "review:carry");
  assert.ok(h.calls.findIndex((c) => c.startsWith("rename:") || c.startsWith("write:")) > 1);
});

test("BL-263 fix (owner TG 4584): a returned Short carries the return; no decision carries nothing (carried null)", async () => {
  const returned = harness({ files: unpublishedFiles(), uploads: [], review: new Map([[sha(manifestText), "returned"]]) });
  assert.deepEqual((await returned.core.recode({ channelId: CH, video: "V14", newCode: "S12" })).review, { carried: "returned" });
  const none = harness({ files: unpublishedFiles(), uploads: [] });
  const result = await none.core.recode({ channelId: CH, video: "V14", newCode: "S12" });
  assert.deepEqual(result.review, { carried: null });
  assert.equal(result.readBack, "verified");
});

test("BL-263 fix (owner TG 4584): a dry run and every refusal carry nothing; an unreadable review document refuses before anything changes", async () => {
  const review = new Map<string, "approved" | "returned">([[sha(manifestText), "approved"]]);
  const dry = harness({ files: unpublishedFiles(), uploads: [], review });
  const result = await dry.core.recode({ channelId: CH, video: "V14", newCode: "S12", dryRun: true });
  assert.equal(result.review, undefined);
  assert.deepEqual(dry.carries, []);
  // A refusal after the approvals (an approved plan slot naming the package) and the device gate refusing: no carry.
  const slot = harness({ files: unpublishedFiles(), uploads: [], review, slots: new Map([["wwe-v14-s0012", { kind: "approved", publishAt: "2026-11-20T10:00:00.000Z", package: { video: "V14", manifestSha256: sha(manifestText), videoId: null } }]]) });
  assert.equal(await codeOf(slot.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_approval_standing:plan_slot");
  assert.deepEqual(slot.carries, []);
  const gated = harness({ files: unpublishedFiles(), uploads: [], review });
  gated.deps.assertMutationAllowed = async () => {
    throw new Error("device_mutation_blocked");
  };
  await assert.rejects(createReleaseRecode(gated.deps).recode({ channelId: CH, video: "V14", newCode: "S12" }));
  assert.deepEqual(gated.carries, []);
  // The review document cannot be read: release_recode_busy review_carry_failed; nothing renamed, no journal.
  const broken = harness({ files: unpublishedFiles(), uploads: [], review, reviewFails: true });
  const before = broken.state();
  assert.equal(await codeOf(broken.core.recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_busy:review_carry_failed");
  assert.deepEqual(broken.state(), before);
  assert.equal(broken.journals.size, 0);
  assert.deepEqual(broken.calls, ["gate", "review:carry"]);
});

test("BL-263 fix (review): a manifest rewritten between the scan and the read is refused manifest_changed before anything is carried", async () => {
  const h = harness({ files: unpublishedFiles(), uploads: [], review: new Map([[sha(manifestText), "approved"]]) });
  const realScan = h.deps.scan;
  // The scan saw an earlier version of the manifest (another hash); the file read now is the current one.
  h.deps.scan = async (c) => {
    const r = await realScan(c);
    return r.status === "ok" ? { ...r, packages: r.packages.map((p) => (p.video === "V14" ? { ...p, manifestSha256: "e".repeat(64) } : p)) } : r;
  };
  const before = h.state();
  assert.equal(await codeOf(createReleaseRecode(h.deps).recode({ channelId: CH, video: "V14", newCode: "S12" })), "release_recode_busy:manifest_changed");
  assert.equal(await codeOf(createReleaseRecode(h.deps).recode({ channelId: CH, video: "V14", newCode: "S12", dryRun: true })), "release_recode_busy:manifest_changed");
  assert.deepEqual(h.carries, []);
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.calls, []);
});

test("BL-263 fix (review): the decision is carried again after the folder step -- a return made during the recode is the one reported", async () => {
  const review = new Map<string, "approved" | "returned">([[sha(manifestText), "approved"]]);
  const h = harness({ files: unpublishedFiles(), uploads: [], review });
  const realRename = h.deps.rename;
  // The owner presses «Вернуть» on the old package after the first carry, before the folder moves.
  h.deps.rename = async (from, to) => {
    if (from === `${WS}/${FROM}`) review.set(sha(manifestText), "returned");
    return realRename(from, to);
  };
  const result = await createReleaseRecode(h.deps).recode({ channelId: CH, video: "V14", newCode: "S12" });
  assert.equal(h.carries.length, 2);
  assert.equal(h.calls.indexOf(`rename:${FROM}->${TO}`) < h.calls.lastIndexOf("review:carry"), true, "the second carry runs after the folder step");
  assert.equal(h.calls.lastIndexOf("review:carry") < h.calls.indexOf("rows:recode"), true);
  assert.deepEqual(h.carries[1], { channelId: CH, fromSha256: sha(manifestText), toSha256: sha(EXPECTED_NEW_MANIFEST), video: "S12", journals: 1, renamedYet: true });
  assert.deepEqual(result.review, { carried: "returned" });
  assert.equal(result.readBack, "verified");
});

test("BL-263 fix (review): a failing second carry does not undo the recode -- warning and read-back problem review_carry", async () => {
  const h = harness({ files: unpublishedFiles(), uploads: [], review: new Map([[sha(manifestText), "approved"]]), reviewFails: (call) => call === 2 });
  const result = await h.core.recode({ channelId: CH, video: "V14", newCode: "S12" });
  assert.equal(result.changed, true);
  assert.ok(h.files.has(`${WS}/${TO}/S12_release.json`), "the recode stands");
  assert.equal(h.uploads().length, 0);
  assert.deepEqual(result.review, { carried: "approved" }, "the first carry's answer");
  assert.equal(result.readBack, "mismatch");
  assert.deepEqual(result.readBackProblems, ["review_carry"]);
  assert.equal(result.warnings?.length, 1);
  assert.ok(result.warnings![0].startsWith("review_carry_failed: review document unreadable"));
  assert.equal(h.calls.includes("rows:undo"), false);
});
