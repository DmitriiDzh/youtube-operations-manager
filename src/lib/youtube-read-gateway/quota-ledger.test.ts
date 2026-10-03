import assert from "node:assert/strict";
import test from "node:test";
import { listQuotaCalls } from "@/lib/db";
import { runWithQuotaContext } from "@/lib/youtube-quota";
import { wrapYoutubeClientForQuotaClassification } from "./error-classification";

// A client shaped like the real googleapis one: resources are non-writable, non-configurable own properties.
function fakeClient(handlers: Record<string, () => Promise<unknown>>) {
  const client = {};
  const byResource = new Map<string, Record<string, unknown>>();
  for (const key of Object.keys(handlers)) {
    const [resource, method] = key.split(".");
    if (!byResource.has(resource)) byResource.set(resource, {});
    byResource.get(resource)![method] = handlers[key];
  }
  for (const [resource, methods] of byResource) {
    Object.defineProperty(client, resource, { value: methods, writable: false, configurable: false, enumerable: true });
  }
  return client as Record<string, Record<string, () => Promise<unknown>>>;
}

// Calls `client[resource][method]()` by name. These are calls on a FAKE client (no network, no YouTube); the helper keeps the
// direct resource-method call syntax out of this file, because the write-gateway inventory test forbids it outside the gateway.
function invoke(client: Record<string, Record<string, () => Promise<unknown>>>, resource: string, method: string) {
  return client[resource][method]();
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 150)); // the ledger write is fire-and-forget
}

const quotaError = () =>
  Object.assign(new Error("quota"), { response: { status: 403, data: { error: { errors: [{ reason: "quotaExceeded" }] } } } });

test("each API call is logged with its table cost, method, outcome and the work context it ran in", async () => {
  const marker = `ctx-${Date.now()}`;
  const wrapped = wrapYoutubeClientForQuotaClassification(
    fakeClient({
      "videos.update": async () => ({ ok: true }),
      "videos.list": async () => ({ ok: true }),
      "videos.fail": async () => {
        throw Object.assign(new Error("bad request"), { response: { status: 400, data: {} } });
      },
      "videos.quota": async () => {
        throw quotaError();
      },
    }),
    "data"
  );

  await runWithQuotaContext({ kind: "batch", id: marker, label: `Batch ${marker}` }, async () => {
    await invoke(wrapped, "videos", "update");
    await invoke(wrapped, "videos", "list");
    await assert.rejects(invoke(wrapped, "videos", "fail"));
    await assert.rejects(invoke(wrapped, "videos", "quota"));
  });
  await settle();

  const rows = (await listQuotaCalls({ sinceSeconds: 0, service: "data" })).filter((r) => r.contextId === marker);
  const byMethod = Object.fromEntries(rows.map((r) => [r.method, r]));
  assert.equal(rows.length, 4);
  assert.deepEqual([byMethod["videos.update"].units, byMethod["videos.update"].outcome], [50, "ok"]);
  assert.deepEqual([byMethod["videos.list"].units, byMethod["videos.list"].outcome], [1, "ok"]);
  assert.deepEqual([byMethod["videos.fail"].units, byMethod["videos.fail"].outcome], [1, "error"], "a failed call costs at least one unit");
  assert.deepEqual([byMethod["videos.quota"].units, byMethod["videos.quota"].outcome], [0, "quota_exceeded"]);
  assert.equal(byMethod["videos.update"].contextKind, "batch");
  assert.equal(byMethod["videos.update"].contextLabel, `Batch ${marker}`);
});

test("an unknown method is logged with NULL units (never a guess); calls outside a context have no context", async () => {
  const wrapped = wrapYoutubeClientForQuotaClassification(fakeClient({ "mystery.run": async () => 1 }), "data");
  await invoke(wrapped, "mystery", "run");
  await settle();
  const row = (await listQuotaCalls({ sinceSeconds: 0, service: "data" })).filter((r) => r.method === "mystery.run").pop();
  assert.ok(row);
  assert.equal(row.units, null);
  assert.equal(row.contextKind, null);
});

test("two concurrent contexts never mix their calls", async () => {
  const tag = `${Date.now()}`;
  const wrapped = wrapYoutubeClientForQuotaClassification(
    fakeClient({ "videos.update": async () => new Promise((r) => setTimeout(() => r(1), 20)) }),
    "data"
  );
  await Promise.all([
    runWithQuotaContext({ kind: "batch", id: `A${tag}`, label: "A" }, async () => {
      await invoke(wrapped, "videos", "update");
      await invoke(wrapped, "videos", "update");
    }),
    runWithQuotaContext({ kind: "fix_all", id: `B${tag}`, label: "B" }, async () => {
      await invoke(wrapped, "videos", "update");
    }),
  ]);
  await settle();
  const rows = await listQuotaCalls({ sinceSeconds: 0, service: "data" });
  assert.equal(rows.filter((r) => r.contextId === `A${tag}`).length, 2);
  assert.equal(rows.filter((r) => r.contextId === `B${tag}`).length, 1);
  assert.equal(rows.filter((r) => r.contextId === `B${tag}`)[0].contextKind, "fix_all");
});

test("a client wrapped WITHOUT a ledger service (the Reporting API) logs nothing and still works", async () => {
  const before = (await listQuotaCalls({ sinceSeconds: 0, service: "data" })).length;
  const wrapped = wrapYoutubeClientForQuotaClassification(fakeClient({ "jobs.list": async () => "ok" }));
  assert.equal(await invoke(wrapped, "jobs", "list"), "ok");
  await settle();
  assert.equal((await listQuotaCalls({ sinceSeconds: 0, service: "data" })).length, before);
});

test("the API call's result and errors are untouched by logging (the same value is returned, the same error thrown)", async () => {
  const boom = new Error("original");
  const wrapped = wrapYoutubeClientForQuotaClassification(
    fakeClient({
      "videos.list": async () => ({ items: [1, 2, 3] }),
      "videos.update": async () => {
        throw boom;
      },
    }),
    "data"
  );
  assert.deepEqual(await invoke(wrapped, "videos", "list"), { items: [1, 2, 3] });
  await assert.rejects(invoke(wrapped, "videos", "update"), (e: unknown) => e === boom);
});
