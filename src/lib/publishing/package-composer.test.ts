import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { DirEntry } from "@/lib/workspace-videos";
import { writeVideoFolderFile } from "./adapters/files";
import { createPackageComposer, defaultPicks, parseTitleDescription, type ComposerDeps } from "./package-composer";
import { parseReleasePackage } from "./packages";

// BL-192 (docs/roadmap/plans/NEW_RELEASE_PACKAGE_PLAN.md §3, AC-NP-01..05). The folder contents are the real ones of Tropico V41 and
// Japan V56 (listed 2026-10-16); the expected values are read off the plan, not off the code.

test("AC-NP-01: TITLE / DESCRIPTION text with a BOM and CRLF gives the title and the description; without either line, null", () => {
  assert.deepEqual(parseTitleDescription("﻿TITLE\r\nCuban Jazz ☕ | 2 Hours\r\n\r\nDESCRIPTION\r\nLine 1\r\n\r\n00:00 A\r\n#Tag\r\n\r\n"), {
    title: "Cuban Jazz ☕ | 2 Hours",
    description: "Line 1\n\n00:00 A\n#Tag",
  });
  assert.deepEqual(parseTitleDescription("title\nT\ndescription\nD"), { title: "T", description: "D" }, "headers in any case");
  assert.equal(parseTitleDescription("TITLE\nOnly a title"), null);
  assert.equal(parseTitleDescription("DESCRIPTION\nOnly a description"), null);
  assert.equal(parseTitleDescription("The TITLE is\nDESCRIPTION\nx"), null, "a header must be a line of its own");
});

const V41 = {
  videos: ["V41 Tropico Jazz.mp4"],
  images: ["0930.png", "Thumbnail_V41_A.jpg", "V41_Cuban-Jazz_A_master.png"],
  texts: ["V41_YouTube_Title_Description.txt"],
  manifest: null,
  youtubeRecord: null,
};

test("AC-NP-02: V41's folder picks its video, Thumbnail_V41_A.jpg and its text file; two thumbnails or two unnamed videos leave the pick open", () => {
  assert.deepEqual(defaultPicks("V41", V41), { video: "V41 Tropico Jazz.mp4", thumbnail: "Thumbnail_V41_A.jpg", text: "V41_YouTube_Title_Description.txt" });
  assert.equal(defaultPicks("V41", { ...V41, images: ["Thumbnail_A.jpg", "Thumbnail_B.jpg"] }).thumbnail, null);
  assert.equal(defaultPicks("V41", { ...V41, images: ["only.png"] }).thumbnail, "only.png", "the only image when there is no Thumbnail_*");
  assert.equal(defaultPicks("V41", { ...V41, videos: ["V41 Tropico Jazz.mp4", "preview.mp4"] }).video, "V41 Tropico Jazz.mp4", "the one named after V41");
  assert.equal(defaultPicks("V41", { ...V41, videos: ["a.mp4", "b.mp4"] }).video, null);
  assert.equal(defaultPicks("V41", { ...V41, texts: [] }).text, null);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The composer on an in-memory workspace.

const WS = "/ws";
const CHANNEL = "UC_tropico";
const V56_FOLDER = "04 Videos/10 October/1022 V56";
const V41_FOLDER = "04 Videos/09 September/0930 V41";
const TEXT_V56 = "﻿TITLE\r\nAutumn in a Japanese Chestnut Orchard 🍂 | 2 Hours\r\n\r\nDESCRIPTION\r\nIntro\r\n\r\n00:00 A\r\n10:00 B\r\n20:00 C\r\n\r\n#JapaneseMusic\r\n";

type Fs = Map<string, { kind: "dir" } | { kind: "file"; text?: string; bytes: number; head?: Uint8Array }>;

function workspace(): Fs {
  const fs: Fs = new Map();
  const dir = (p: string) => fs.set(p, { kind: "dir" });
  const file = (p: string, bytes: number, extra: { text?: string; head?: Uint8Array } = {}) => fs.set(p, { kind: "file", bytes, ...extra });
  dir("04 Videos");
  dir("04 Videos/10 October");
  dir(V56_FOLDER);
  file(`${V56_FOLDER}/V56 Japan Countryside Music.mp4`, 860_000_000);
  file(`${V56_FOLDER}/Thumbnail_V56.jpg`, 400_000, { head: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) });
  file(`${V56_FOLDER}/1022.png`, 900_000);
  file(`${V56_FOLDER}/V56_Title_Description.txt`, TEXT_V56.length, { text: TEXT_V56 });
  file(`${V56_FOLDER}/V56_YouTube_Chapters.txt`, 100);
  file(`${V56_FOLDER}/V56_Report.txt`, 100);
  dir("04 Videos/09 September");
  dir(V41_FOLDER);
  file(`${V41_FOLDER}/V41 Tropico Jazz.mp4`, 500_000_000);
  file(`${V41_FOLDER}/Thumbnail_V41_A.jpg`, 300_000, { head: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) });
  dir(`${V41_FOLDER}/work`);
  file(`${V41_FOLDER}/work/inner.mp4`, 10);
  dir("04 Videos/10 October/1014 Live 24-7");
  file("04 Videos/10 October/1014 Live 24-7/loop.mp4", 10);
  return fs;
}

function setup(options: { baseline?: string | null; held?: string[]; probe?: number | null | "no_ffprobe"; fs?: Fs } = {}) {
  const fs = options.fs ?? workspace();
  const writes: Array<{ folder: string; name: string; text: string }> = [];
  const rel = (abs: string) => abs.replace(/^\/ws\/?/, "");
  const deps: ComposerDeps = {
    workspace: async () => WS,
    validateWorkspace: async () => ({ ok: true }),
    async listDir(absolutePath) {
      const base = rel(absolutePath);
      const entries: DirEntry[] = [];
      for (const [p, node] of fs) {
        if (p.startsWith(`${base}/`) && !p.slice(base.length + 1).includes("/")) entries.push({ name: p.slice(base.length + 1), kind: node.kind });
      }
      return entries;
    },
    async resolveFile(_ws, relativePath) {
      const node = fs.get(relativePath);
      return node?.kind === "file" ? { path: `${WS}/${relativePath}`, bytes: node.bytes } : null;
    },
    async readText(absolutePath) {
      const node = fs.get(rel(absolutePath));
      if (node?.kind !== "file" || node.text === undefined) throw new Error("not text");
      return node.text;
    },
    async readHead(absolutePath) {
      const node = fs.get(rel(absolutePath));
      return node?.kind === "file" ? (node.head ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47])) : new Uint8Array();
    },
    probeDuration: async () => (options.probe === undefined ? 7200.5 : options.probe),
    channel: async (channelId) => ({ channelId, defaultLanguage: options.baseline === undefined ? "en" : options.baseline, defaultAudioLanguage: options.baseline === undefined ? "en" : options.baseline }),
    videos: async () => [{ videoId: "old1", title: "Something else" }],
    heldVideos: async () => new Set(options.held ?? []),
    async writeManifest(_ws, folder, name, text) {
      writes.push({ folder, name, text });
      fs.set(`${folder}/${name}`, { kind: "file", bytes: text.length, text });
    },
    join: (...parts) => parts.join("/"),
  };
  return { composer: createPackageComposer(deps), writes, fs };
}

const refusedWith = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test("listFolders: every MMDD Vn folder with a video directly inside, newest first; a folder without Vn and a file in work/ are not offered", async () => {
  const { composer } = setup();
  const folders = await composer.listFolders(CHANNEL);
  assert.deepEqual(
    folders.map((f) => [f.folder, f.video, f.hasPackage]),
    [
      [V56_FOLDER, "V56", false],
      [V41_FOLDER, "V41", false],
    ]
  );
  assert.deepEqual(folders[1].files.videos, ["V41 Tropico Jazz.mp4"], "work/inner.mp4 is not a direct child");
});

test("draft: V56's folder fills the title, description, files, size, duration and baseline; tags and date empty; no problems", async () => {
  const { composer } = setup();
  const draft = await composer.draft(CHANNEL, { folder: V56_FOLDER });
  assert.deepEqual(draft.picks, { video: "V56 Japan Countryside Music.mp4", thumbnail: "Thumbnail_V56.jpg", text: "V56_Title_Description.txt" });
  assert.equal(draft.title, "Autumn in a Japanese Chestnut Orchard 🍂 | 2 Hours");
  assert.equal(draft.description, "Intro\n\n00:00 A\n10:00 B\n20:00 C\n\n#JapaneseMusic");
  assert.deepEqual([draft.sizeBytes, draft.durationSeconds, draft.tags, draft.plannedPublishDate], [860_000_000, 7200.5, [], null]);
  assert.deepEqual(draft.languages, { defaultLanguage: "en", defaultAudioLanguage: "en" });
  assert.deepEqual(draft.problems, []);
  assert.deepEqual(draft.existing, { exists: false, replaceable: true, reason: null });
});

test("draft: the owner's edits are checked like a package (a too-long title, chapters not starting at 0:00) and a picked file must be the folder's own", async () => {
  const { composer } = setup();
  const draft = await composer.draft(CHANNEL, { folder: V56_FOLDER, title: "x".repeat(101), description: "00:05 A\n10:00 B\n20:00 C" });
  assert.deepEqual(draft.problems.map((p) => p.code).sort(), ["chapters_first_not_zero", "title_too_long"].sort());
  await assert.rejects(() => composer.draft(CHANNEL, { folder: V56_FOLDER, files: { thumbnail: "../../secret.jpg" } }), refusedWith("package_file_invalid"));
  await assert.rejects(() => composer.draft(CHANNEL, { folder: V56_FOLDER, files: { video: "Thumbnail_V56.jpg" } }), refusedWith("package_file_invalid"));
});

test("draft: a text file without TITLE / DESCRIPTION is flagged and leaves the fields empty", async () => {
  const fs = workspace();
  fs.set(`${V56_FOLDER}/V56_Title_Description.txt`, { kind: "file", bytes: 5, text: "just words" });
  const { composer } = setup({ fs });
  const draft = await composer.draft(CHANNEL, { folder: V56_FOLDER });
  assert.deepEqual([draft.textUnreadable, draft.title, draft.description], [true, "", ""]);
});

test("AC-NP-03: saving V56 writes V56_release.json with exactly the plan's fields, and it parses as a ready package", async () => {
  const { composer, writes } = setup();
  await composer.save(CHANNEL, { folder: V56_FOLDER, tags: ["japanese music"], plannedPublishDate: "2026-10-22" });
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].folder, writes[0].name], [V56_FOLDER, "V56_release.json"]);
  const manifest = JSON.parse(writes[0].text);
  assert.deepEqual(manifest, {
    schema: "yt-release-package/1",
    channelId: CHANNEL,
    video: "V56",
    mix: null,
    plannedPublishDate: "2026-10-22",
    files: { video: "V56 Japan Countryside Music.mp4", thumbnail: "Thumbnail_V56.jpg" },
    sizeBytes: 860_000_000,
    durationSeconds: 7200.5,
    title: "Autumn in a Japanese Chestnut Orchard 🍂 | 2 Hours",
    description: "Intro\n\n00:00 A\n10:00 B\n20:00 C\n\n#JapaneseMusic",
    tags: ["japanese music"],
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    ready: true,
    problems: [],
    createdBy: "owner",
  });
  const parsed = parseReleasePackage(manifest);
  assert.deepEqual([parsed.problems, parsed.pkg?.ready], [[], true]);
});

test("AC-NP-04: each refusal writes nothing", async () => {
  const cases: Array<[string, Parameters<typeof setup>[0], Record<string, unknown>]> = [
    ["package_folder_invalid", {}, { folder: "04 Videos/10 October/1014 Live 24-7" }],
    ["package_folder_invalid", {}, { folder: "05 Other/10 October/1022 V56" }],
    ["package_folder_invalid", {}, { folder: "04 Videos/10 October/../1022 V56" }],
    ["package_no_baseline", { baseline: null }, { folder: V56_FOLDER }],
    ["package_title_empty", {}, { folder: V56_FOLDER, title: "   " }],
    ["validation_failed", {}, { folder: V56_FOLDER, plannedPublishDate: "2026-02-30" }],
    ["validation_failed", {}, { folder: V56_FOLDER, tags: [1] }],
    ["validation_failed", {}, { folder: V56_FOLDER, extra: true }],
    ["package_duration_unknown", { probe: "no_ffprobe" }, { folder: V56_FOLDER }],
    ["package_duration_unknown", { probe: null }, { folder: V56_FOLDER }],
    ["package_no_thumbnail", {}, { folder: V56_FOLDER, files: { thumbnail: null } }],
  ];
  for (const [code, options, input] of cases) {
    const { composer, writes } = setup(options);
    await assert.rejects(() => composer.save(CHANNEL, input), refusedWith(code), `${code} ${JSON.stringify(input)}`);
    assert.equal(writes.length, 0, code);
  }
  const noVideo = workspace();
  noVideo.delete(`${V56_FOLDER}/V56 Japan Countryside Music.mp4`);
  const { composer, writes } = setup({ fs: noVideo });
  await assert.rejects(() => composer.save(CHANNEL, { folder: V56_FOLDER }), refusedWith("package_no_video"));
  assert.equal(writes.length, 0);
});

test("AC-NP-05: an existing package is replaced only with replace; never once uploaded, queued here or reported by another computer", async () => {
  const withPackage = () => {
    const fs = workspace();
    fs.set(`${V56_FOLDER}/V56_release.json`, { kind: "file", bytes: 10, text: "{}" });
    return fs;
  };
  const plain = setup({ fs: withPackage() });
  await assert.rejects(() => plain.composer.save(CHANNEL, { folder: V56_FOLDER }), refusedWith("package_exists"));
  assert.equal(plain.writes.length, 0);
  await plain.composer.save(CHANNEL, { folder: V56_FOLDER, replace: true });
  assert.equal(plain.writes.length, 1);

  const uploadedFs = withPackage();
  uploadedFs.set(`${V56_FOLDER}/V56_youtube.json`, { kind: "file", bytes: 10, text: '{"videoId":"abc"}' });
  const uploaded = setup({ fs: uploadedFs });
  assert.deepEqual((await uploaded.composer.draft(CHANNEL, { folder: V56_FOLDER })).existing, { exists: true, replaceable: false, reason: "uploaded" });
  await assert.rejects(() => uploaded.composer.save(CHANNEL, { folder: V56_FOLDER, replace: true }), refusedWith("package_held"));

  const queued = setup({ fs: withPackage(), held: ["V56"] });
  assert.deepEqual((await queued.composer.draft(CHANNEL, { folder: V56_FOLDER })).existing, { exists: true, replaceable: false, reason: "queued" });
  await assert.rejects(() => queued.composer.save(CHANNEL, { folder: V56_FOLDER, replace: true }), refusedWith("package_held"));
  assert.equal(uploaded.writes.length + queued.writes.length, 0);
});

test("writeVideoFolderFile: writes inside 04 Videos only, whole, and refuses a symlinked folder that points outside", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bl192-"));
  const ws = path.join(root, "ws");
  await mkdir(path.join(ws, "04 Videos", "10 October", "1022 V56"), { recursive: true });
  await mkdir(path.join(root, "outside"));
  await symlink(path.join(root, "outside"), path.join(ws, "04 Videos", "10 October", "1023 V57"));
  await writeVideoFolderFile(ws, V56_FOLDER, "V56_release.json", "{\"a\":1}\n");
  assert.equal(await readFile(path.join(ws, V56_FOLDER, "V56_release.json"), "utf8"), "{\"a\":1}\n");
  assert.deepEqual((await readdir(path.join(ws, V56_FOLDER))).filter((n) => n.endsWith(".tmp")), [], "no temporary file left");
  await assert.rejects(() => writeVideoFolderFile(ws, "04 Videos/10 October/1023 V57", "V57_release.json", "{}"));
  assert.deepEqual(await readdir(path.join(root, "outside")), []);
  await assert.rejects(() => writeVideoFolderFile(ws, "04 Videos", "V1_release.json", "{}"), "not the 04 Videos folder itself");
  await writeFile(path.join(ws, "x.txt"), "");
  await assert.rejects(() => writeVideoFolderFile(ws, V56_FOLDER, "../x.txt", "{}"));
});
