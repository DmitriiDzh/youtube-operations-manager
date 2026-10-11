import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mediaKindOf, PLAN_JOB_OUTPUT_SUBDIRS } from "@/lib/generation-plans/contracts";
import { GEMINI_OUTPUT_SUBDIR } from "@/lib/gemini-media/contracts";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { createExchangeFs, resolveExchangeFile } from "@/lib/workspace-exchange";
import { createAuditionGetHandler } from "./serve";

// BL-175 phase 3 AC-V3-02 (docs/roadmap/plans/VISUAL_REVIEW_PLAN.md §8.3): a Gemini output named by a plan plays through the
// audition route, wired as the route wires it (`resolveExchangeFile` with the plans' folder list), with Range; a missing one is 404.

test("AC-V3-02: a From YTM/gemini/<jobId>/ file plays through the audition route; a missing one is not found", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ytm-gemini-route-")));
  try {
    const ws = path.join(root, "ws");
    const job = path.join(ws, "99 Data Exchange", "From YTM", "gemini", "gm_1");
    await mkdir(job, { recursive: true });
    await mkdir(path.join(ws, "99 Data Exchange", "Sent to YTM"), { recursive: true });
    await writeFile(path.join(job, "image-1.png"), "1234567");
    let file = "From YTM/gemini/gm_1/image-1.png";
    const unavailable = (reason: string) => new Error(reason);
    const handler = createAuditionGetHandler({
      getSession: async () => ({ user: { id: "u1" } }),
      assertVisible: async () => undefined,
      resolveAudition: async () => ({ channelId: "UC1", kind: "sent", relativePath: file }),
      workspaceOf: async () => ws,
      resolveSentFile: (workspace, relativePath) => resolveExchangeFile({ workspace, relativePath, jobSubdirs: PLAN_JOB_OUTPUT_SUBDIRS, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true as const }), isPathInsideOrEqual, unavailable }),
      resolveJobFile: async () => {
        throw new Error("not a job output of this plan");
      },
    });
    const request = () => new Request("http://127.0.0.1:3000/api/generation-plans/P/audition?itemKey=I&attemptRef=g1", { headers: { host: "127.0.0.1:3000", range: "bytes=2-4" } });
    const res = await handler(request(), { params: Promise.resolve({ planId: "P" }) });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(await res.text(), "345");
    assert.equal(mediaKindOf(file), "image");
    file = "From YTM/gemini/gm_1/missing.png";
    assert.equal((await handler(request(), { params: Promise.resolve({ planId: "P" }) })).status, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BL-175 §G: the plans' Gemini folder is the Gemini module's own output folder (a rename there must fail here)", () => {
  assert.ok(PLAN_JOB_OUTPUT_SUBDIRS.includes(GEMINI_OUTPUT_SUBDIR));
});
