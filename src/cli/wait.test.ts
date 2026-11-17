import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createFactoryTokenServices, type FactoryTokenStore } from "@/lib/factory-agent-tokens/services";
import { createFactoryMcpEndpoint } from "@/lib/factory-mcp-endpoint";
import { DomainError } from "@/lib/shared-domain";
import { createFactoryMcpServer, type FactoryToolDeps } from "@/mcp/factory-server";
import { runWaitCli, type WaitCliIo } from "./wait";

// BL-271 (docs/roadmap/plans/WAIT_TOOLS_PLAN.md §3.3, AC-WT-02/08/09/13, §6 "CLI"): expected values from the plan -- exactly one JSON
// line on stdout for every ending; exit 0 succeeded, 1 failed / cancelled / rejected / changes requested / expired, 2 everything else;
// a restart-shaped sequence (restarting -> refused connections -> done) exits 0 with the new version; a job wait survives a drop
// under 10 minutes and gives up past it; the token is read from an environment variable only and never printed.

const FO_TOKEN = `ytom_fo_${"x".repeat(43)}`;
const START = Date.parse("2026-11-17T12:00:00.000Z");

type Step =
  | { result: Record<string, unknown>; blockMs?: number }
  | { toolError: { code: string; message: string; details?: unknown } }
  | { loss: true; ms?: number }
  | { http: number; body: unknown };

/** A fake endpoint at the fetch level, answering like the SDK's JSON response; a virtual clock that sleeps and blocks advance. */
function harness(script: (call: { n: number; args: Record<string, unknown>; url: string; now: number }) => Step, env: Record<string, string | undefined> = { YTOM_TOKEN: FO_TOKEN }) {
  let now = START;
  const lines: string[] = [];
  const calls: Array<{ url: string; tool: string; args: Record<string, unknown>; headers: Record<string, string> }> = [];
  const io: WaitCliIo = {
    env,
    now: () => now,
    sleep: async (ms) => void (now += ms),
    write: (line) => void lines.push(line),
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body)) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
      calls.push({ url, tool: body.params.name, args: body.params.arguments, headers: init.headers as Record<string, string> });
      const step = script({ n: calls.length, args: body.params.arguments, url, now });
      if ("loss" in step) {
        now += step.ms ?? 1000;
        throw new TypeError("fetch failed");
      }
      if ("http" in step) return new Response(typeof step.body === "string" ? step.body : JSON.stringify(step.body), { status: step.http, headers: { "content-type": typeof step.body === "string" ? "text/html" : "application/json" } });
      if ("toolError" in step) {
        return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: step.toolError }) }], isError: true }, jsonrpc: "2.0", id: body.id });
      }
      now += step.blockMs ?? 0;
      return Response.json({ result: { content: [{ type: "text", text: JSON.stringify(step.result) }], structuredContent: step.result }, jsonrpc: "2.0", id: body.id });
    },
  };
  return { io, lines, calls, now: () => now };
}

const wr = (over: Record<string, unknown>) => ({ target: "media_job", id: "j1", final: false, outcome: "still_running", status: "generating", snapshot: { jobId: "j1" }, waitedSeconds: 240, ...over });
const only = (lines: string[]) => {
  assert.equal(lines.length, 1, `exactly one line, got ${lines.length}`);
  return JSON.parse(lines[0]) as Record<string, unknown> & { error?: { code: string; message: string } };
};

test("AC-WT-02: final outcomes -> one JSON line and the exit code of the plan's table", async () => {
  const table: Array<[string, number]> = [["succeeded", 0], ["failed", 1], ["partly_failed", 1], ["cancelled", 1], ["rejected", 1], ["changes_requested", 1], ["expired", 1]];
  for (const [outcome, code] of table) {
    const h = harness(() => ({ result: wr({ final: true, outcome, status: "x" }) }));
    assert.equal(await runWaitCli(["media_job", "j1"], h.io), code, outcome);
    const line = only(h.lines);
    assert.deepEqual([line.final, line.outcome, line.target, line.id], [true, outcome, "media_job", "j1"]);
    assert.equal(line.error, undefined);
  }
});

test("AC-WT-01/05: rounds repeat silently with timeoutSeconds = min(240, remaining) until final; --timeout past -> still_running, exit 2", async () => {
  let n = 0;
  const h = harness(({ args }) => (++n < 3 ? { result: wr({}), blockMs: Number(args.timeoutSeconds) * 1000 } : { result: wr({ final: true, outcome: "succeeded", status: "done" }) }));
  assert.equal(await runWaitCli(["media_job", "j1", "--timeout", "600"], h.io), 0);
  assert.deepEqual(h.calls.map((c) => c.args.timeoutSeconds), [240, 240, 120]);
  assert.equal(only(h.lines).waitedSeconds, 480);

  const t = harness(({ args }) => ({ result: wr({}), blockMs: Number(args.timeoutSeconds) * 1000 }));
  assert.equal(await runWaitCli(["media_job", "j1", "--timeout", "300"], t.io), 2);
  const line = only(t.lines);
  assert.deepEqual([line.final, line.outcome, line.status, line.waitedSeconds], [false, "still_running", "generating", 300]);
  assert.deepEqual(t.calls.map((c) => c.args.timeoutSeconds), [240, 60]);
});

test("AC-WT-02/14: blocked and not_in_review end the wait at once with exit 2; restarting backs off 5 s instead of calling again at once", async () => {
  for (const outcome of ["blocked", "not_in_review"]) {
    const h = harness(() => ({ result: wr({ outcome }) }));
    assert.equal(await runWaitCli(["upload", "up1"], h.io), 2);
    assert.equal(only(h.lines).outcome, outcome);
    assert.equal(h.calls.length, 1);
  }
  const times: number[] = [];
  const h = harness(({ n, now }) => (times.push(now), n === 1 ? { result: wr({ outcome: "restarting" }) } : { result: wr({ final: true, outcome: "succeeded" }) }));
  assert.equal(await runWaitCli(["media_job", "j1"], h.io), 0);
  assert.equal(times[1] - times[0], 5000);
});

test("AC-WT-13: the token prefix picks the endpoint and the tool; the token is sent only as a Bearer header", async () => {
  const cases: Array<[string, string, string]> = [
    [`ytom_ch_UC_A.${"y".repeat(43)}`, "http://127.0.0.1:3000/api/mcp", "agent_wait"],
    [FO_TOKEN, "http://127.0.0.1:3000/api/mcp/factory", "factory_wait"],
    [`ytom_pr_${"z".repeat(43)}`, "http://127.0.0.1:3000/api/mcp/producer", "producer_wait"],
  ];
  for (const [token, url, tool] of cases) {
    const h = harness(() => ({ result: wr({ final: true, outcome: "succeeded" }) }), { MY_TOKEN: token });
    assert.equal(await runWaitCli(["upload", "V12", "--channel", "UC_A", "--token-env", "MY_TOKEN"], h.io), 0);
    assert.deepEqual([h.calls[0].url, h.calls[0].tool], [url, tool]);
    assert.equal(h.calls[0].headers.authorization, `Bearer ${token}`);
    assert.deepEqual(h.calls[0].args, { target: "upload", id: "V12", channelId: "UC_A", timeoutSeconds: 240 });
    assert.ok(!h.lines[0].includes(token), "the token is never printed");
  }
  const custom = harness(() => ({ result: wr({ final: true, outcome: "succeeded" }) }), { YTOM_TOKEN: FO_TOKEN, YTOM_URL: "http://127.0.0.1:4555/" });
  await runWaitCli(["media_job", "j1"], custom.io);
  assert.equal(custom.calls[0].url, "http://127.0.0.1:4555/api/mcp/factory");
});

test("AC-WT-13 / AC-WT-02: a missing token, an unknown token kind, a token as an argument and bad usage -> one JSON line, exit 2, no token echoed", async () => {
  const cases: Array<[string[], Record<string, string | undefined>, string]> = [
    [["media_job", "j1"], {}, "token_missing"],
    [["media_job", "j1"], { YTOM_TOKEN: "  " }, "token_missing"],
    [["media_job", "j1"], { YTOM_TOKEN: "sk-something" }, "token_unrecognized"],
    [["media_job", "j1", "--token", FO_TOKEN], { YTOM_TOKEN: FO_TOKEN }, "token_in_argument"],
    [["media_job", FO_TOKEN], { YTOM_TOKEN: FO_TOKEN }, "token_in_argument"],
    [["media_job", "j1", `--channel=${FO_TOKEN}`], { YTOM_TOKEN: FO_TOKEN }, "token_in_argument"],
    [[], { YTOM_TOKEN: FO_TOKEN }, "usage"],
    [["weekly_build", "x"], { YTOM_TOKEN: FO_TOKEN }, "usage"],
    [["media_job", "j1", "extra"], { YTOM_TOKEN: FO_TOKEN }, "usage"],
    [["media_job", "j1", "--secret", "abc"], { YTOM_TOKEN: FO_TOKEN }, "usage"],
    [["media_job", "j1", "--timeout", "0"], { YTOM_TOKEN: FO_TOKEN }, "usage"],
    [["media_job", "j1", "--timeout", "259201"], { YTOM_TOKEN: FO_TOKEN }, "usage"],
    [["media_job", "j1", "--until", "ready"], { YTOM_TOKEN: FO_TOKEN }, "usage"],
    [["media_job", "j1", "--url", "file:///etc"], { YTOM_TOKEN: FO_TOKEN }, "usage"],
  ];
  for (const [argv, env, code] of cases) {
    const h = harness(() => assert.fail("no call"), env);
    assert.equal(await runWaitCli(argv, h.io), 2, argv.join(" "));
    const line = only(h.lines);
    assert.equal(line.error?.code, code, argv.join(" "));
    assert.ok(!h.lines[0].includes(FO_TOKEN.slice(8)), `no token in the output of ${code}`);
    assert.equal(h.calls.length, 0);
  }
  const ok = harness(() => ({ result: wr({ final: true, outcome: "succeeded" }) }));
  assert.equal(await runWaitCli(["media_job", "j1", "--timeout", "259200"], ok.io), 0, "72 h is accepted");
});

test("an endpoint refusal (revoked token, MCP switched off) or a tool error exits 2 at once with its code -- never retried as a lost connection", async () => {
  for (const [status, code] of [[401, "AGENT_TOKEN_INVALID"], [403, "MCP_CONNECTION_DISABLED"]] as const) {
    const h = harness(() => ({ http: status, body: { error: { code, message: "refused" } } }));
    assert.equal(await runWaitCli(["media_job", "j1"], h.io), 2);
    assert.equal(only(h.lines).error?.code, code);
    assert.equal(h.calls.length, 1);
  }
  for (const code of ["not_found", "invalid_request", "target_unavailable", "CHANNEL_NOT_ACTIVE"]) {
    const h = harness(() => ({ toolError: { code, message: "m" } }));
    assert.equal(await runWaitCli(["media_job", "j1"], h.io), 2);
    assert.equal(only(h.lines).error?.code, code);
  }
});

test("AC-WT-08: restart current -- pins the request id, prints nothing across the server going away, exits 0 with toVersion / toSchema", async () => {
  const seen: Array<[number, string]> = [];
  const h = harness(({ n, args }) => {
    seen.push([n, String(args.id)]);
    if (n === 1) return { result: { target: "restart", id: "rq_7", final: false, outcome: "still_running", status: "open", snapshot: {} }, blockMs: 30_000 };
    if (n === 2) return { result: { target: "restart", id: "rq_7", final: false, outcome: "server_stopping", status: "restarting", snapshot: {} } };
    if (n <= 30) return { loss: true, ms: 1000 }; // refused connections while it rebuilds and starts
    if (n === 31) return { http: 500, body: "<html>starting</html>" }; // a page while the server comes back (not the endpoint's JSON)
    return { result: { target: "restart", id: "rq_7", final: true, outcome: "succeeded", status: "done", snapshot: { id: "rq_7", toVersion: "0.1.2 (abc123)", toSchema: 131 } } };
  });
  assert.equal(await runWaitCli(["restart", "current"], h.io), 0);
  const line = only(h.lines);
  assert.deepEqual([line.id, line.final, line.outcome, (line.snapshot as Record<string, unknown>).toVersion, (line.snapshot as Record<string, unknown>).toSchema], ["rq_7", true, "succeeded", "0.1.2 (abc123)", 131]);
  assert.equal(seen[0][1], "current");
  assert.ok(seen.slice(1).every(([, id]) => id === "rq_7"), "every call after the first names the pinned id");
});

test("AC-WT-08: restart current right after the script -- no_restart_request is retried for 30 s; a later serverStartedAt counts as done (boot satisfied the file)", async () => {
  // The request appears on the third try (the server took up the file within 15 s).
  const appears = harness(({ n }) =>
    n < 3
      ? { toolError: { code: "no_restart_request", message: "none", details: { serverStartedAt: "2026-11-17T08:00:00.000Z", lastRestart: null } } }
      : { result: { target: "restart", id: "rq_8", final: true, outcome: "succeeded", status: "done", snapshot: { toVersion: "v2" } } }
  );
  assert.equal(await runWaitCli(["restart", "current"], appears.io), 0);
  assert.equal(only(appears.lines).id, "rq_8");

  // Never appears, the server never restarted: no_restart_request after the 30 s grace, exit 2.
  const never = harness(() => ({ toolError: { code: "no_restart_request", message: "none", details: { serverStartedAt: "2026-11-17T08:00:00.000Z", lastRestart: null } } }));
  assert.equal(await runWaitCli(["restart", "current"], never.io), 2);
  assert.equal(only(never.lines).error?.code, "no_restart_request");
  assert.ok(never.now() - START >= 30_000 && never.now() - START < 40_000);

  // The server was restarting already (connection refused), came back started after this wait began, and has no row: done.
  const boot = harness(({ n }) =>
    n < 4
      ? { loss: true, ms: 1000 }
      : { toolError: { code: "no_restart_request", message: "none", details: { serverStartedAt: new Date(START + 20_000).toISOString(), lastRestart: { id: "rq_prev", toVersion: "v3", toSchema: 132 } } } }
  );
  assert.equal(await runWaitCli(["restart", "current"], boot.io), 0);
  const line = only(boot.lines);
  assert.deepEqual([line.final, line.outcome, (line.snapshot as Record<string, unknown>).toVersion], [true, "succeeded", "v3"]);
});

test("AC-WT-09: a job wait survives a 9-minute drop silently; an 11-minute drop exits 2 (server_unreachable); never reached at all: 60 s", async () => {
  const drop = (minutes: number) =>
    harness(({ n, now }) => {
      if (n === 1) return { result: wr({}), blockMs: 10_000 };
      if (now < START + 10_000 + minutes * 60_000) return { loss: true, ms: 1000 };
      return { result: wr({ final: true, outcome: "succeeded", status: "done" }) };
    });
  const short = drop(9);
  assert.equal(await runWaitCli(["media_job", "j1"], short.io), 0);
  assert.equal(only(short.lines).outcome, "succeeded");

  const long = drop(11);
  assert.equal(await runWaitCli(["media_job", "j1"], long.io), 2);
  const line = only(long.lines);
  assert.equal(line.error?.code, "server_unreachable");
  assert.equal(line.status, "generating", "the last known status is kept");
  const lostFor = long.now() - (START + 10_000);
  assert.ok(lostFor >= 10 * 60_000 && lostFor < 10 * 60_000 + 10_000, `gave up after ${lostFor} ms of loss`);

  const never = harness(() => ({ loss: true, ms: 100 }));
  assert.equal(await runWaitCli(["media_job", "j1"], never.io), 2);
  assert.equal(only(never.lines).error?.code, "server_unreachable");
  assert.ok(never.now() - START >= 60_000 && never.now() - START < 70_000);

  // A restart wait keeps retrying a lost server until its own deadline.
  const restart = harness(() => ({ loss: true, ms: 1000 }));
  assert.equal(await runWaitCli(["restart", "rq_1", "--timeout", "1800"], restart.io), 2);
  assert.ok(restart.now() - START >= 1_800_000);
});

// -- against the real Factory endpoint (the SDK's transport, the token check, the session wrapper) --------------------------------

function memoryTokenStore(): FactoryTokenStore {
  const rows: Array<{ id: string; tokenHash: string; label: string | null; createdAt: Date; revoked: boolean }> = [];
  return {
    async replace(input) {
      for (const row of rows) row.revoked = true;
      rows.push({ ...input, createdAt: new Date(), revoked: false });
    },
    async revoke() {
      return 0;
    },
    async findActiveByHash(hash) {
      return rows.find((row) => row.tokenHash === hash && !row.revoked) ?? null;
    },
    async findByHash(hash) {
      const row = rows.find((candidate) => candidate.tokenHash === hash);
      return row ? { ...row, revokedAt: null } : null;
    },
    async listActive() {
      return rows.filter((row) => !row.revoked);
    },
  };
}

async function realFactoryEndpoint(waitFor: FactoryToolDeps["wait"]["waitFor"]) {
  const tokens = createFactoryTokenServices({ store: memoryTokenStore(), generateSecret: () => "s".repeat(43) });
  const { token } = await tokens.issueToken({});
  const recorded: string[] = [];
  const deps = new Proxy(
    { recordOutcome: async (outcome: string) => void recorded.push(outcome), wait: { waitFor }, assertMutationAllowed: async () => undefined },
    { get: (target, name) => (name in target ? target[name as keyof typeof target] : ({} as never)) }
  ) as unknown as FactoryToolDeps;
  const endpoint = createFactoryMcpEndpoint({
    isConnectionEnabled: async () => true,
    verifyToken: (t) => tokens.verifyToken(t),
    createServer: ({ session }) => createFactoryMcpServer(deps, { connectionEnabled: true, session }),
  });
  return { endpoint, token, recorded };
}

test("against the real Factory endpoint: rounds until final, exit 0; a refusal keeps its code; the calls are never counted", async () => {
  let rounds = 0;
  const { endpoint, token, recorded } = await realFactoryEndpoint(async (input, scope) => {
    assert.deepEqual(scope, { channelId: null });
    const args = input as { id: string; timeoutSeconds: number };
    if (args.id === "nope") throw new DomainError({ code: "not_found", message: "No media_job with this id on this computer.", details: { target: "media_job", id: "nope" } });
    rounds += 1;
    return rounds < 3 ? wr({ waitedSeconds: args.timeoutSeconds }) : wr({ final: true, outcome: "succeeded", status: "done", snapshot: { outputs: ["a.png"] } });
  });
  const lines: string[] = [];
  const io: WaitCliIo = {
    env: { YTOM_TOKEN: token },
    now: () => Date.now(),
    sleep: async () => undefined,
    write: (line) => void lines.push(line),
    // The endpoint checks the Host header (loopback); a real fetch sends it on the wire.
    fetch: async (url, init) => endpoint.handle(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), host: "127.0.0.1:3000" } })),
  };
  assert.equal(await runWaitCli(["media_job", "j1"], io), 0);
  const line = only(lines);
  assert.deepEqual([line.final, line.outcome, (line.snapshot as { outputs: string[] }).outputs], [true, "succeeded", ["a.png"]]);
  assert.equal(rounds, 3);
  lines.length = 0;
  assert.equal(await runWaitCli(["media_job", "nope"], io), 2);
  assert.deepEqual(only(lines).error, { code: "not_found", message: "No media_job with this id on this computer.", details: { target: "media_job", id: "nope" } });
  assert.deepEqual(recorded, [], "factory_wait is never counted as MCP activity");
});

test("AC-WT-02/13 end to end: `node --import tsx src/cli/wait.ts` over real HTTP prints exactly one JSON line, nothing on stderr, no token", async () => {
  const { endpoint, token } = await realFactoryEndpoint(async () => wr({ final: true, outcome: "failed", status: "failed", snapshot: { errorCode: "x" } }));
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const response = await endpoint.handle(
      new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "POST" ? Buffer.concat(chunks) : undefined })
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const child = spawn(process.execPath, ["--no-deprecation", "--import", "tsx", "src/cli/wait.ts", "media_job", "j1", "--url", `http://127.0.0.1:${port}`], {
      env: { ...process.env, YTOM_TOKEN: token, NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 1, `exit 1 for failed (stderr: ${stderr})`);
    assert.equal(stderr, "");
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    assert.equal(stdout.endsWith("\n"), true);
    const line = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.deepEqual([line.target, line.id, line.final, line.outcome, line.status], ["media_job", "j1", true, "failed", "failed"]);
    assert.ok(!stdout.includes(token) && !stderr.includes(token));
  } finally {
    server.close();
  }
});

test("review: restart current pinned from the first answer -- a cancellation during the wait ends final cancelled, exit 1", async () => {
  const h = harness(({ n, args }) =>
    n === 1
      ? { result: { target: "restart", id: "rq_9", final: false, outcome: "still_running", status: "open", snapshot: {} }, blockMs: Number(args.timeoutSeconds) * 1000 }
      : args.id === "rq_9"
        ? { result: { target: "restart", id: "rq_9", final: true, outcome: "cancelled", status: "cancelled", snapshot: {} } }
        : { toolError: { code: "no_restart_request", message: "none", details: { serverStartedAt: "2026-11-17T08:00:00.000Z", lastRestart: null } } }
  );
  assert.equal(await runWaitCli(["restart", "current"], h.io), 1);
  const line = only(h.lines);
  assert.deepEqual([line.id, line.final, line.outcome], ["rq_9", true, "cancelled"]);
});
