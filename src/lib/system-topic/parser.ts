import { SYSTEM_COMMAND_WORDS, type SystemCommand, type SystemCommandWord } from "./contracts";
import { SYSTEM_CHANNEL_NAME_PATTERN } from "./schemas";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2, ADR 0053 §3): the fixed grammar. Nothing in a message is ever executed: a text maps to one of the
// six commands or to `unknown`. The command word is case-insensitive and may carry a leading `/` and a `@botname` suffix (how Telegram
// writes a command picked from the bot's menu); words are separated by any whitespace.

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function commandWord(token: string): SystemCommandWord | null {
  const match = /^\/?([A-Za-z]+)(?:@[A-Za-z0-9_]{1,64})?$/.exec(token);
  if (!match) return null;
  const word = match[1].toLowerCase();
  return (SYSTEM_COMMAND_WORDS as readonly string[]).includes(word) ? (word as SystemCommandWord) : null;
}

export function parseSystemCommand(text: string): SystemCommand {
  const parts = text.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return { kind: "unknown" };
  const word = commandWord(parts[0]);
  if (!word) return { kind: "unknown" };
  const args = parts.slice(1);
  const channel = (value: string | undefined) => value !== undefined && SYSTEM_CHANNEL_NAME_PATTERN.test(value);
  const id = (value: string | undefined) => value !== undefined && ID_PATTERN.test(value);
  switch (word) {
    case "help":
      return args.length === 0 ? { kind: "help" } : { kind: "usage", command: word };
    case "status":
      if (args.length === 0) return { kind: "status", channel: null };
      return args.length === 1 && channel(args[0]) ? { kind: "status", channel: args[0] } : { kind: "usage", command: word };
    case "stop":
      return args.length === 2 && channel(args[0]) && id(args[1]) ? { kind: "stop", channel: args[0], target: args[1] } : { kind: "usage", command: word };
    case "go":
      return args.length === 1 && channel(args[0]) ? { kind: "go", channel: args[0] } : { kind: "usage", command: word };
    case "approve":
      return args.length === 1 && id(args[0]) ? { kind: "approve", id: args[0] } : { kind: "usage", command: word };
    case "deny":
      return args.length === 1 && id(args[0]) ? { kind: "deny", id: args[0] } : { kind: "usage", command: word };
  }
}

/** The usage line of each command (English: bot replies follow the MCP/API/CLI rule, AGENTS.md §H). */
export const SYSTEM_COMMAND_USAGE: Record<SystemCommandWord, string> = {
  help: "help",
  status: "status [<channel>]",
  stop: "stop <channel> <jobId|plan>",
  go: "go <channel>",
  approve: "approve <id>",
  deny: "deny <id>",
};

export const SYSTEM_HELP_TEXT = [
  "Commands:",
  `${SYSTEM_COMMAND_USAGE.help} -- this list`,
  `${SYSTEM_COMMAND_USAGE.status} -- the factory status (one channel when named)`,
  `${SYSTEM_COMMAND_USAGE.stop} -- stop a factory job (not available yet)`,
  `${SYSTEM_COMMAND_USAGE.go} -- start the channel's plan (not available yet)`,
  `${SYSTEM_COMMAND_USAGE.approve} / ${SYSTEM_COMMAND_USAGE.deny} -- answer a paid-call request (not available yet)`,
].join("\n");
