import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createGeminiWorkspace } from "./adapters/workspace";

// BL-174 review round 1 (AC-GM-06 on the REAL rules, not a fake): an input is a regular file named relative to the channel's
// `99 Data Exchange/Sent to YTM/`, proven contained after symlinks; outputs go to `From YTM`, created inside the workspace; a channel
// without a workspace on this computer is refused.

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

test("the real workspace rules: contained inputs only, outputs inside the workspace, no workspace refused", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gemini-ws-")));
  try {
    const ws = path.join(root, "channel");
    const sent = path.join(ws, "99 Data Exchange", "Sent to YTM");
    await mkdir(path.join(sent, "refs"), { recursive: true });
    await writeFile(path.join(sent, "refs", "a.png"), "PNG");
    await writeFile(path.join(root, "outside.png"), "secret");
    await symlink(path.join(root, "outside.png"), path.join(sent, "escape.png"));
    const port = createGeminiWorkspace(async (channelId) => (channelId === "UC1" ? { configured: true, path: ws } : { configured: false }));

    const ok = await port.resolveInput("UC1", "refs/a.png");
    const info = await stat(path.join(sent, "refs", "a.png"));
    assert.deepEqual([ok.path, ok.bytes, ok.identity?.ino], [path.join(sent, "refs", "a.png"), 3, info.ino]);
    for (const bad of ["../outside.png", "refs/../../outside.png", "/etc/hosts", path.join(root, "outside.png"), "escape.png", "missing.png", "refs", "refs\\a.png"]) {
      await expectCode(port.resolveInput("UC1", bad), "gemini_input_unavailable");
    }
    await expectCode(port.resolveInput("UC_OTHER", "refs/a.png"), "gemini_input_unavailable");

    const out = await port.resolveOutputRoot("UC1");
    assert.equal(out, path.join(ws, "99 Data Exchange", "From YTM"));
    assert.ok((await stat(out)).isDirectory());
    await expectCode(port.resolveOutputRoot("UC_OTHER"), "gemini_workspace_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
