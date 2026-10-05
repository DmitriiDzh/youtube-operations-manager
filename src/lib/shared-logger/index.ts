export type Logger = {
  info(payload: { event: string; context?: Record<string, unknown> }): void;
  error(payload: { event: string; context?: Record<string, unknown> }): void;
};

/**
 * The single structured logger (architecture audit 2026-10-01, M3 -- previously three copies, two of
 * which wrote `info` to stdout). Every level goes to **stderr**: stdout is a protocol channel in two
 * of this app's three runtimes -- the MCP server speaks JSON-RPC over stdio, and every CLI command's
 * contract is exactly one JSON envelope on stdout (docs/DEVELOPMENT_PLAYBOOK.md §6.8) -- so a log line
 * there corrupts the stream. The web server captures both streams, so nothing is lost there.
 */
function write(level: "info" | "error", payload: { event: string; context?: Record<string, unknown> }) {
  const line = {
    level,
    event: payload.event,
    timestamp: new Date().toISOString(),
    ...(payload.context ? { context: payload.context } : {}),
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export function createDefaultLogger(): Logger {
  return {
    info(payload) {
      write("info", payload);
    },
    error(payload) {
      write("error", payload);
    },
  };
}
