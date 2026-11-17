import { fileURLToPath } from "node:url";
import { sleep } from "@/lib/shared-async";
import { exitCodeFor, WAIT_MAX_SECONDS, WAIT_TARGETS, WAIT_UNTIL, type WaitOutcome, type WaitTarget } from "@/lib/operation-wait/contracts";

/**
 * BL-271 (docs/roadmap/plans/WAIT_TOOLS_PLAN.md §3.3, ADR 0075): `npm run --silent wait -- <target> <id> [options]` -- wait until one
 * operation is final and print ONE JSON line, without any LLM turn while it waits (run it as a background shell command).
 *
 * A thin HTTP client of the caller's OWN MCP endpoint (chosen by the token's prefix): it repeats `*_wait` calls of up to 240 s, prints
 * nothing in between, retries a lost connection (the server restarting is the expected path of `restart`), and never touches the
 * database -- channel scoping stays in the endpoint (the token), and no migration can race the server. The token is read from an
 * environment variable only (default YTOM_TOKEN); it is never accepted as an argument, printed or logged.
 *
 * Exit codes: 0 succeeded; 1 failed / partly_failed / cancelled / rejected / changes_requested / expired; 2 everything else (timeout,
 * blocked, not_in_review, not found, invalid input, endpoint refused, unreachable, token missing).
 */

export const WAIT_CLI_DEFAULT_TIMEOUT_SECONDS = 14_400;
export const WAIT_CLI_MAX_TIMEOUT_SECONDS = 259_200;
/** A lost connection is retried this often. */
export const WAIT_CLI_RETRY_MS = 5_000;
/** A target other than `restart`: continuous connection loss allowed before `server_unreachable`. */
export const WAIT_CLI_MAX_LOSS_MS = 10 * 60_000;
/** The server unreachable from the very first round (any target, `restart` included): `server_unreachable` after this. */
export const WAIT_CLI_FIRST_ROUND_GRACE_MS = 60_000;
/** `restart current` with no request yet: the developer's request file is taken up within 15 s, so allow this long. */
export const WAIT_CLI_RESTART_GRACE_MS = 30_000;
/** Each HTTP call is aborted this long after its block should have ended. */
const CALL_MARGIN_MS = 30_000;

const ENDPOINTS: ReadonlyArray<{ prefix: string; path: string; tool: string }> = [
  { prefix: "ytom_ch_", path: "/api/mcp", tool: "agent_wait" },
  { prefix: "ytom_fo_", path: "/api/mcp/factory", tool: "factory_wait" },
  { prefix: "ytom_pr_", path: "/api/mcp/producer", tool: "producer_wait" },
];

export type WaitCliIo = {
  env: Readonly<Record<string, string | undefined>>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** One line of stdout (the CLI calls it exactly once). */
  write: (line: string) => void;
};

type Options = {
  target: WaitTarget;
  id: string;
  channelId?: string;
  storyboardId?: string;
  until?: string;
  timeoutSeconds: number;
  url: string;
  tokenEnv: string;
};

type Snapshot = Record<string, unknown>;
type LastResult = { status: string; snapshot: Snapshot };
type CliError = { code: string; message: string; details?: unknown };

class UsageError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const VALUE_OPTIONS: Record<string, keyof Pick<Options, "channelId" | "storyboardId" | "until" | "url" | "tokenEnv"> | "timeout"> = {
  "--channel": "channelId",
  "--storyboard": "storyboardId",
  "--until": "until",
  "--timeout": "timeout",
  "--url": "url",
  "--token-env": "tokenEnv",
};

const looksLikeToken = (value: string) => /^ytom_/i.test(value.trim());

/** Parses the arguments. A message never repeats an argument's value (one could be a token pasted by mistake). */
export function parseWaitArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Options {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  // Checked first, whatever else is wrong: a token pasted into the command line is refused as that, never echoed.
  if (argv.some((arg) => looksLikeToken(arg) || (arg.startsWith("--") && arg.includes("=") && looksLikeToken(arg.slice(arg.indexOf("=") + 1))))) {
    throw new UsageError("token_in_argument", "A token is never passed as an argument: put it in an environment variable (YTOM_TOKEN, or --token-env <VAR>).");
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const key = VALUE_OPTIONS[name];
    if (!key) throw new UsageError("usage", `Unknown option ${name.replace(/[^A-Za-z0-9-]/g, "").slice(0, 32)}.`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.length === 0) throw new UsageError("usage", `${name} needs a value.`);
    values[key] = value;
  }
  if (positional.length !== 2) throw new UsageError("usage", "Usage: npm run --silent wait -- <target> <id> [--channel <channelId>] [--storyboard <storyboardId>] [--until <until>] [--timeout <seconds>] [--url <url>] [--token-env <VAR>]");
  const [target, id] = positional;
  if (!(WAIT_TARGETS as readonly string[]).includes(target)) throw new UsageError("usage", `target must be one of ${WAIT_TARGETS.join(", ")}.`);
  if (id.length > 128) throw new UsageError("usage", "id is at most 128 characters.");
  const allowed = WAIT_UNTIL[target as WaitTarget];
  if (values.until !== undefined && !(allowed ?? []).includes(values.until)) {
    throw new UsageError("usage", allowed ? `--until must be one of ${allowed.join(", ")} for ${target}.` : `${target} takes no --until.`);
  }
  let timeoutSeconds = WAIT_CLI_DEFAULT_TIMEOUT_SECONDS;
  if (values.timeout !== undefined) {
    timeoutSeconds = Number(values.timeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > WAIT_CLI_MAX_TIMEOUT_SECONDS) {
      throw new UsageError("usage", `--timeout is a number of seconds from 1 to ${WAIT_CLI_MAX_TIMEOUT_SECONDS}.`);
    }
  }
  const tokenEnv = values.tokenEnv ?? "YTOM_TOKEN";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tokenEnv)) throw new UsageError("usage", "--token-env names an environment variable (letters, digits, _).");
  const url = (values.url ?? env.YTOM_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/.test(url)) throw new UsageError("usage", "--url is the app's address, e.g. http://127.0.0.1:3000.");
  return {
    target: target as WaitTarget,
    id,
    ...(values.channelId !== undefined ? { channelId: values.channelId } : {}),
    ...(values.storyboardId !== undefined ? { storyboardId: values.storyboardId } : {}),
    ...(values.until !== undefined ? { until: values.until } : {}),
    timeoutSeconds,
    url,
    tokenEnv,
  };
}

type CallAnswer =
  | { kind: "loss" }
  | { kind: "refused"; error: CliError }
  | { kind: "tool_error"; error: CliError }
  | { kind: "result"; result: { id?: unknown; final?: unknown; outcome?: unknown; status?: unknown; snapshot?: unknown } };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One `tools/call` of the endpoint's wait tool. Never throws: a network failure, an abort or a 502/503/504 is a lost connection. */
async function callOnce(io: WaitCliIo, endpointUrl: string, token: string, tool: string, args: Record<string, unknown>, rpcId: number, blockSeconds: number): Promise<CallAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), blockSeconds * 1000 + CALL_MARGIN_MS);
  let response: Response;
  let text: string;
  try {
    response = await io.fetch(endpointUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch {
    return { kind: "loss" };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) return { kind: "loss" };
  // A refusal (bad or revoked token, MCP switched off, not loopback, no such route: a wrong --url) ends the wait at once, whatever the
  // body -- it is never a page of a server that is coming back.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    let error: Record<string, unknown> = {};
    try {
      error = record(record(JSON.parse(text)).error);
    } catch {
      // not JSON: the status alone
    }
    return {
      kind: "refused",
      error: { code: typeof error.code === "string" ? error.code : `http_${response.status}`, message: typeof error.message === "string" ? error.message : `The endpoint answered HTTP ${response.status}.` },
    };
  }
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(text));
  } catch {
    // Not JSON (an error page while the server starts, a proxy's page): not this app's endpoint answer -- treated like a lost connection,
    // so a restart wait is not ended by a page the server shows while it comes back.
    return { kind: "loss" };
  }
  if (!response.ok) {
    const error = record(body.error);
    return { kind: "refused", error: { code: typeof error.code === "string" ? error.code : `http_${response.status}`, message: typeof error.message === "string" ? error.message : `The endpoint answered HTTP ${response.status}.` } };
  }
  if (body.error !== undefined) {
    const error = record(body.error);
    return { kind: "refused", error: { code: "rpc_error", message: typeof error.message === "string" ? error.message : "The endpoint refused the call." } };
  }
  const result = record(body.result);
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? record(result.content[0]) : {};
    let parsed: Record<string, unknown> = {};
    try {
      parsed = record(record(JSON.parse(String(content.text ?? ""))).error);
    } catch {
      // The SDK's own input check answers in plain text (e.g. an unknown target): an invalid request.
    }
    return {
      kind: "tool_error",
      error: {
        code: typeof parsed.code === "string" ? parsed.code : "invalid_request",
        message: typeof parsed.message === "string" ? parsed.message : String(content.text ?? "The endpoint refused the call.").slice(0, 500),
        ...(parsed.details !== undefined ? { details: parsed.details } : {}),
      },
    };
  }
  const structured = record(result.structuredContent);
  if (Object.keys(structured).length > 0) return { kind: "result", result: structured };
  try {
    return { kind: "result", result: record(JSON.parse(String(record(Array.isArray(result.content) ? result.content[0] : {}).text ?? ""))) };
  } catch {
    return { kind: "refused", error: { code: "rpc_error", message: "The endpoint's answer could not be read." } };
  }
}

/** Runs the CLI; returns the exit code. Writes exactly one line through `io.write`. */
export async function runWaitCli(argv: readonly string[], io: WaitCliIo): Promise<number> {
  const started = io.now();
  let options: Options;
  try {
    options = parseWaitArgs(argv, io.env);
  } catch (error) {
    const usage = error instanceof UsageError ? error : new UsageError("usage", "Invalid arguments.");
    io.write(JSON.stringify({ target: null, id: null, final: false, outcome: null, status: null, snapshot: null, waitedSeconds: 0, error: { code: usage.code, message: usage.message } }));
    return 2;
  }

  let id = options.id;
  let last: LastResult | null = null;
  const waited = () => Math.round((io.now() - started) / 1000);
  const emit = (fields: { final: boolean; outcome: WaitOutcome | null; status?: string | null; snapshot?: Snapshot | null; error?: CliError }) => {
    io.write(
      JSON.stringify({
        target: options.target,
        id,
        final: fields.final,
        outcome: fields.outcome,
        status: fields.status ?? last?.status ?? null,
        snapshot: fields.snapshot ?? last?.snapshot ?? null,
        waitedSeconds: waited(),
        ...(fields.error ? { error: fields.error } : {}),
      })
    );
  };
  const fail = (error: CliError) => {
    emit({ final: false, outcome: null, error });
    return 2;
  };

  const token = io.env[options.tokenEnv];
  if (!token || token.trim().length === 0) return fail({ code: "token_missing", message: `No token in the environment variable ${options.tokenEnv}.` });
  const endpoint = ENDPOINTS.find((entry) => token.startsWith(entry.prefix));
  if (!endpoint) return fail({ code: "token_unrecognized", message: `The token in ${options.tokenEnv} is not a channel agent, Factory Operator or Producer token.` });
  const endpointUrl = `${options.url}${endpoint.path}`;

  const deadline = started + options.timeoutSeconds * 1000;
  let connected = false;
  let lossSince: number | null = null;
  let rpcId = 0;

  for (;;) {
    const remaining = deadline - io.now();
    if (remaining <= 0) {
      if (last) {
        emit({ final: false, outcome: "still_running" });
        return 2;
      }
      return fail({ code: connected ? "timeout" : "server_unreachable", message: connected ? "The wait timed out before the first answer." : "The app could not be reached before the timeout." });
    }
    const block = Math.max(1, Math.min(WAIT_MAX_SECONDS, Math.ceil(remaining / 1000)));
    const args: Record<string, unknown> = {
      target: options.target,
      id,
      ...(options.channelId !== undefined ? { channelId: options.channelId } : {}),
      ...(options.storyboardId !== undefined ? { storyboardId: options.storyboardId } : {}),
      ...(options.until !== undefined ? { until: options.until } : {}),
      timeoutSeconds: block,
    };
    const answer = await callOnce(io, endpointUrl, token, endpoint.tool, args, ++rpcId, block);

    if (answer.kind === "loss") {
      const now = io.now();
      // A server that never gave a real answer is most likely not running here, or the URL is wrong: 60 s, for every target.
      if (!connected && now - started >= WAIT_CLI_FIRST_ROUND_GRACE_MS) return fail({ code: "server_unreachable", message: `The app did not answer at ${options.url}.` });
      if (options.target !== "restart") {
        // Once connected, a restart is the expected loss of a restart wait (retried until the deadline); for any other target the
        // server should be back within 10 minutes.
        lossSince ??= now;
        if (connected && now - lossSince >= WAIT_CLI_MAX_LOSS_MS) return fail({ code: "server_unreachable", message: "The app stopped answering for more than 10 minutes." });
      }
      await io.sleep(WAIT_CLI_RETRY_MS);
      continue;
    }
    connected = true;
    lossSince = null;
    if (answer.kind === "refused") return fail(answer.error);

    if (answer.kind === "tool_error") {
      const error = answer.error;
      if (error.code === "no_restart_request" && options.target === "restart" && id === "current") {
        const details = record(error.details);
        const serverStartedAt = typeof details.serverStartedAt === "string" ? Date.parse(details.serverStartedAt) : Number.NaN;
        // The server started after this wait did: the restart happened (a request file the boot satisfied leaves no row to pin).
        if (Number.isFinite(serverStartedAt) && serverStartedAt > started) {
          const lastRestart = record(details.lastRestart);
          emit({ final: true, outcome: "succeeded", status: "done", snapshot: { ...lastRestart, serverStartedAt: details.serverStartedAt } });
          return 0;
        }
        if (io.now() - started < WAIT_CLI_RESTART_GRACE_MS) {
          await io.sleep(WAIT_CLI_RETRY_MS);
          continue;
        }
      }
      return fail(error);
    }

    const result = answer.result;
    if (typeof result.id === "string" && result.id.length > 0) id = result.id; // pin: `current` / a video code -> the real id
    const outcome = (typeof result.outcome === "string" ? result.outcome : "still_running") as WaitOutcome;
    last = { status: typeof result.status === "string" ? result.status : "unknown", snapshot: record(result.snapshot) };
    if (result.final === true) {
      emit({ final: true, outcome });
      return exitCodeFor(outcome);
    }
    if (outcome === "blocked" || outcome === "not_in_review") {
      emit({ final: false, outcome });
      return 2;
    }
    // The server is restarting or stopping: back off instead of calling again at once (it answers these immediately).
    if (outcome === "restarting" || outcome === "server_stopping") await io.sleep(WAIT_CLI_RETRY_MS);
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  let wrote = false;
  runWaitCli(process.argv.slice(2), {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
    write: (line) => {
      wrote = true;
      process.stdout.write(`${line}\n`);
    },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      if (!wrote) process.stdout.write(`${JSON.stringify({ target: null, id: null, final: false, outcome: null, status: null, snapshot: null, waitedSeconds: 0, error: { code: "internal_error", message: "The wait CLI failed." } })}\n`);
      process.exitCode = 2;
    });
}
