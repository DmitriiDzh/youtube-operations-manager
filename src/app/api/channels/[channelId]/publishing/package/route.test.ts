import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { PackageDraft } from "@/lib/publishing";
import { createPackageSaveHandler } from "./route";
import { createPackageDraftHandler } from "../package-draft/route";
import { createPackageFoldersHandler } from "../package-folders/route";

// BL-192 (NEW_RELEASE_PACKAGE_PLAN.md §2): a Web session is required and only the active channel's folders are read or written
// (ADR 0004, AGENTS.md §F); the composer's refusals keep their code and status.

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const session = async () => ({ user: { id: "u1" } });
const assertActiveChannel = async ({ channelId }: { channelId: string }) => {
  if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "Not the active channel" });
};
const post = (body: unknown) => new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const DRAFT = { folder: "04 Videos/10 October/1022 V56", video: "V56" } as unknown as PackageDraft;

test("package-folders: 401 without a session, refused for another channel, the active channel's folders otherwise", async () => {
  const listed: string[] = [];
  const listFolders = async (channelId: string) => {
    listed.push(channelId);
    return [];
  };
  assert.equal((await createPackageFoldersHandler({ getSession: async () => null, assertActiveChannel, listFolders })(new Request("http://x/"), ctx("UC_active"))).status, 401);
  const handler = createPackageFoldersHandler({ getSession: session, assertActiveChannel, listFolders });
  assert.notEqual((await handler(new Request("http://x/"), ctx("UC_other"))).status, 200);
  const ok = await handler(new Request("http://x/"), ctx("UC_active"));
  assert.deepEqual([ok.status, await ok.json(), listed], [200, { folders: [] }, ["UC_active"]]);
});

test("package-draft and package: 401, a body without folder is 400, another channel is refused, a refusal keeps its code and status", async () => {
  for (const make of [createPackageDraftHandler, createPackageSaveHandler]) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const run = async (channelId: string, input: Record<string, unknown>) => {
      calls.push([channelId, input]);
      if (input.folder === "held") throw new DomainError({ code: "package_held", message: "held" });
      return DRAFT;
    };
    const deps = { getSession: session, assertActiveChannel, draft: run, save: run };
    assert.equal((await make({ ...deps, getSession: async () => null })(post({ folder: "f" }), ctx("UC_active"))).status, 401);
    const handler = make(deps);
    assert.equal((await handler(post("not json"), ctx("UC_active"))).status, 400);
    assert.equal((await handler(post({ title: "x" }), ctx("UC_active"))).status, 400);
    assert.notEqual((await handler(post({ folder: "f" }), ctx("UC_other"))).status, 200);
    const held = await handler(post({ folder: "held" }), ctx("UC_active"));
    assert.deepEqual([held.status, (await held.json()).error], [409, "package_held"]);
    const ok = await handler(post({ folder: "f", title: "T" }), ctx("UC_active"));
    assert.deepEqual([ok.status, await ok.json()], [200, { draft: DRAFT }]);
    assert.deepEqual(calls.map(([channelId]) => channelId), ["UC_active", "UC_active"], "never called for another channel");
  }
});
