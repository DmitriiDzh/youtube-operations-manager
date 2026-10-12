import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createLongWaitFetch } from "./http";

// BL-179 independent review (blocker): the long-wait transport behind the Omni call. Its contract is fetch's, as `jsonRequest`
// uses it: an answer (any status, never a followed redirect), a transport error with its `code`, or the signal's reason.

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("an answer that comes late is read whole; method, headers and body are sent as given", async () => {
  const seen: Array<{ method?: string; key?: string; body: string }> = [];
  const { server, url } = await serve((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, key: req.headers["x-goog-api-key"] as string, body });
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, 300);
    });
  });
  try {
    const response = await createLongWaitFetch({ maxBodyBytes: 1024 })(`${url}/v1beta/interactions`, { method: "POST", headers: { "x-goog-api-key": "K" }, body: '{"a":1}', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(seen, [{ method: "POST", key: "K", body: '{"a":1}' }]);
  } finally {
    server.close();
  }
});

test("a redirect is returned as an answer, never followed", async () => {
  let hits = 0;
  const { server, url } = await serve((_req, res) => {
    hits += 1;
    res.writeHead(302, { location: "https://elsewhere.example/" });
    res.end();
  });
  try {
    const response = await createLongWaitFetch({ maxBodyBytes: 1024 })(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 302);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

test("the signal ends the wait with its own reason (a TimeoutError stays a timeout); a refused connection keeps its code", async () => {
  const { server, url } = await serve(() => {
    // never answers
  });
  try {
    await assert.rejects(createLongWaitFetch({ maxBodyBytes: 1024 })(url, { signal: AbortSignal.timeout(200) }), (error: unknown) => (error as { name?: string }).name === "TimeoutError");
  } finally {
    server.closeAllConnections();
    server.close();
  }
  const closed = await serve(() => undefined);
  const deadUrl = closed.url;
  await new Promise<void>((resolve) => closed.server.close(() => resolve()));
  await assert.rejects(createLongWaitFetch({ maxBodyBytes: 1024 })(deadUrl, {}), (error: unknown) => (error as { code?: string }).code === "ECONNREFUSED");
});

test("an answer over the size bound is cut, never buffered whole", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(4096, 1));
  });
  try {
    await assert.rejects(createLongWaitFetch({ maxBodyBytes: 1024 })(url, {}), (error: unknown) => (error as { code?: string }).code === "ERR_BODY_TOO_LARGE");
  } finally {
    server.close();
  }
});

test("a timeout that fires while the body is still arriving rejects with the timeout, never resolves a cut body", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200);
    res.write("partial");
  });
  try {
    await assert.rejects(createLongWaitFetch({ maxBodyBytes: 1024 })(url, { signal: AbortSignal.timeout(300) }), (error: unknown) => (error as { name?: string }).name === "TimeoutError");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
