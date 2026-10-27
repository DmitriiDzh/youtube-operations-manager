import type { SystemCommand } from "./contracts";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2, ADR 0053 Amendment 1): the fixed grammar `help`, `approve <id>`, `deny <id>`; `status`, `stop` and
// `go` are recognised only to answer that the hub handles them. Nothing in a message is ever executed. The command word is
// case-insensitive and may carry a leading `/` and a `@botname` suffix; words are separated by any whitespace.

/** A request id as the factory names its files (`<id>.json`): no leading dot, no path separator. */
export const SYSTEM_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

const WORDS = ["help", "status", "stop", "go", "approve", "deny"] as const;

function commandWord(token: string): (typeof WORDS)[number] | null {
  const match = /^\/?([A-Za-z]+)(?:@[A-Za-z0-9_]{1,64})?$/.exec(token);
  if (!match) return null;
  const word = match[1].toLowerCase();
  return (WORDS as readonly string[]).includes(word) ? (word as (typeof WORDS)[number]) : null;
}

export function parseSystemCommand(text: string): SystemCommand {
  const parts = text.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return { kind: "unknown" };
  const word = commandWord(parts[0]);
  if (!word) return { kind: "unknown" };
  const args = parts.slice(1);
  switch (word) {
    case "help":
      return args.length === 0 ? { kind: "help" } : { kind: "usage", command: "help" };
    case "status":
    case "stop":
    case "go":
      return { kind: "hub", word };
    case "approve":
    case "deny":
      return args.length === 1 && SYSTEM_REQUEST_ID_PATTERN.test(args[0]) ? { kind: word, id: args[0] } : { kind: "usage", command: word };
  }
}

/** Bot replies are English (MCP/API/CLI rule, AGENTS.md §H). */
export const SYSTEM_HUB_REPLY = "handled by the hub in each channel's topic";

export const SYSTEM_HELP_TEXT = [
  "Commands here:",
  "approve <id> -- approve a paid-call request (then confirm it in YT Manager)",
  "deny <id> -- refuse a paid-call request",
  "help -- this list",
  `status, stop, go -- ${SYSTEM_HUB_REPLY}`,
].join("\n");

export const SYSTEM_COMMAND_USAGE = { help: "help", approve: "approve <id>", deny: "deny <id>" } as const;
