import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createInboxWriter, nodeInboxFsOps, workspaceRootOf, type InboxFsOps } from "./fs";

// BL-248 (REVIEW_NOTIFY_PLAN.md §5, §8; AC-RN-09). A temp folder only -- never the real workspace.

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "review-notify-"));
}

test("AC-RN-09: every name the folder sees before the rename starts with .tmp-, the final file appears whole", async () => {
  const dir = await tempDir();
  try {
    const seen: string[] = [];
    const ops: InboxFsOps = {
      ...nodeInboxFsOps,
      async writeFile(file, content) {
        seen.push(`write ${path.basename(file)}`);
        await nodeInboxFsOps.writeFile(file, content);
        // While the content is being written, the folder shows no non-dot file.
        assert.deepEqual((await readdir(dir)).filter((n) => !n.startsWith(".")), []);
      },
      async rename(from, to) {
        seen.push(`rename ${path.basename(from)} -> ${path.basename(to)}`);
        await nodeInboxFsOps.rename(from, to);
      },
    };
    const outcome = await createInboxWriter(ops, () => "abc")(dir, "REVIEW-DECISION-clip-a-b.md", "hello");
    assert.equal(outcome, "written");
    assert.deepEqual(seen, ["write .tmp-abc", "rename .tmp-abc -> REVIEW-DECISION-clip-a-b.md"]);
    assert.deepEqual(await readdir(dir), ["REVIEW-DECISION-clip-a-b.md"]);
    assert.equal(await readFile(path.join(dir, "REVIEW-DECISION-clip-a-b.md"), "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AC-RN-06: an existing file is never rewritten", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "REVIEW-DECISION-clip-a-b.md"), "original");
    assert.equal(await createInboxWriter()(dir, "REVIEW-DECISION-clip-a-b.md", "new"), "exists");
    assert.equal(await readFile(path.join(dir, "REVIEW-DECISION-clip-a-b.md"), "utf8"), "original");
    assert.deepEqual(await readdir(dir), ["REVIEW-DECISION-clip-a-b.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AC-RN-09: a failed write leaves no temporary file and throws", async () => {
  const dir = await tempDir();
  try {
    const ops: InboxFsOps = { ...nodeInboxFsOps, rename: async () => Promise.reject(new Error("disk gone")) };
    await assert.rejects(() => createInboxWriter(ops)(dir, "REVIEW-DECISION-clip-a-b.md", "x"), /disk gone/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AC-RN-10: a missing folder throws (the tick retries), nothing is created", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(() => createInboxWriter()(path.join(dir, "Inbox"), "REVIEW-DECISION-clip-a-b.md", "x"));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a name that is not a plain file name is refused", async () => {
  await assert.rejects(() => createInboxWriter()("/nowhere", ".hidden.md", "x"));
  await assert.rejects(() => createInboxWriter()("/nowhere", "a/b.md", "x"));
});

test("§8: the workspace root is the one parent of every channel workspace, else none", () => {
  assert.equal(workspaceRootOf(["/Volumes/T9/YouTube/01 Tropico Jazz", "/Volumes/T9/YouTube/02 Japan"]), "/Volumes/T9/YouTube");
  assert.equal(workspaceRootOf(["/Volumes/T9/YouTube/01 Tropico Jazz", "/Users/me/Other/02 Japan"]), null);
  assert.equal(workspaceRootOf([]), null);
});
