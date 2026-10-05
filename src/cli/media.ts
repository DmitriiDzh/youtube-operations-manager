#!/usr/bin/env node

import { loadEnvConfig } from "@next/env";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getOperatorCliEnabled, rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation, RecoveryModeError } from "@/lib/device-mutation-gate";
import { OperationLockError } from "@/lib/operation-lock";
import { createMediaGenerationCore, DomainError, type MediaGenerationCore } from "@/lib/media-generation";

// Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md §2.8/§2.9) -- the operator CLI for media
// generation, the thing every script under scripts/media/ wraps:
//
//   npm run media -- status
//   npm run media -- credentials-test
//   npm run media -- settings
//   npm run media -- gpus | datacenters | volumes | templates | pods
//   npm run media -- volume-create --name <name> --dc <EU-RO-1> --size <GB>
//   npm run media -- pod-get <podId> | pod-terminate <podId> | pod-create --file <body.json>
//   npm run media -- s3-ls [prefix] | s3-get <key> <dest> | s3-rm <key>
//
// Runs in-process against the same encrypted credential store the Web UI fills, so no key is ever
// an argument or an environment variable (AC-P14-20). A separate entry point from
// src/cli/video-metadata.ts on purpose (AGENTS.md §M): disabling this feature removes nothing from
// the main CLI. Same gates as that CLI: "Operator CLI access" must be on, and anything that
// mutates (pod-create, pod-terminate, volume-create, s3-rm) passes the device mutation gate.

loadEnvConfig(process.cwd());

export const MEDIA_CLI_COMMANDS = [
  "status",
  "credentials-test",
  "settings",
  "gpus",
  "datacenters",
  "volumes",
  "volume-create",
  "templates",
  "template-create",
  "cpus",
  "pods",
  "pod-get",
  "pod-create",
  "pod-terminate",
  "s3-ls",
  "s3-get",
  "s3-put",
  "s3-rm",
] as const;
export type MediaCliCommand = (typeof MEDIA_CLI_COMMANDS)[number];

const MUTATING_COMMANDS: ReadonlySet<MediaCliCommand> = new Set<MediaCliCommand>([
  "volume-create",
  "template-create",
  "pod-create",
  "pod-terminate",
  "s3-put",
  "s3-rm",
]);

export const HELP = [
  "Usage: npm run media -- <command> [args]",
  "  status                                  credentials status, settings, readiness (never a secret)",
  "  credentials-test                        one RunPod read (+ one S3 listing when configured)",
  "  settings                                the stored Settings → Media values",
  "  gpus | cpus | datacenters | volumes | templates | pods",
  "  volume-create --name <n> --dc <ID> --size <GB>   creates a network volume (billed monthly)",
  "  template-create --file <body.json>      RunPod v2 template body (name, image, ports, env, disk, ...)",
  "  pod-get <podId>",
  "  pod-create --file <body.json>           RunPod v2 create-pod body (see docs); terminated by you, never stopped",
  "  pod-terminate <podId>",
  "  s3-ls [prefix] | s3-get <key> <dest> | s3-put <file> <key> | s3-rm <key>",
].join("\n");

export type ParsedMediaArgs = { command: MediaCliCommand; positional: string[]; flags: Record<string, string | true> };

export function parseMediaArgs(argv: string[]): ParsedMediaArgs {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    throw new DomainError({ code: "validation_failed", message: HELP });
  }
  if (!(MEDIA_CLI_COMMANDS as readonly string[]).includes(command)) {
    throw new DomainError({ code: "validation_failed", message: `Unknown command "${command}".\n${HELP}` });
  }
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: command as MediaCliCommand, positional, flags };
}

export function classifyMediaCommand(command: MediaCliCommand): "read_only" | "gated" {
  return MUTATING_COMMANDS.has(command) ? "gated" : "read_only";
}

function serialize(value: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } }) {
  return JSON.stringify(value);
}

function requireFlag(flags: Record<string, string | true>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || !value) throw new DomainError({ code: "validation_failed", message: `--${name} is required` });
  return value;
}

function requirePositional(positional: string[], index: number, name: string): string {
  const value = positional[index];
  if (!value) throw new DomainError({ code: "validation_failed", message: `<${name}> is required` });
  return value;
}

async function readJsonFile(readFileText: (path: string) => Promise<string>, flags: Record<string, string | true>): Promise<unknown> {
  const text = await readFileText(requireFlag(flags, "file"));
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError({ code: "validation_failed", message: "--file must contain valid JSON" });
  }
}

export async function runMediaCli(args: {
  argv: string[];
  core?: MediaGenerationCore;
  operatorCliEnabled?: () => Promise<boolean>;
  assertDeviceAvailable?: () => Promise<void>;
  readFileText?: (path: string) => Promise<string>;
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  writeStdout?: (line: string) => void;
}): Promise<number> {
  const writeStdout = args.writeStdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const parsed = parseMediaArgs(args.argv);

    if (!(await (args.operatorCliEnabled ?? getOperatorCliEnabled)())) {
      throw new DomainError({
        code: "AGENT_TOKEN_INVALID",
        message: 'the CLI is the operator\'s tool and "Operator CLI access" is off (Settings -> AI Agent)',
      });
    }
    if (classifyMediaCommand(parsed.command) === "gated") {
      await (args.assertDeviceAvailable ?? (() => assertDeviceAvailableForMutation(rawSqlClient)))();
    }

    const core = args.core ?? createMediaGenerationCore();
    const readFileText = args.readFileText ?? ((p: string) => readFile(p, "utf8"));
    let data: unknown;
    switch (parsed.command) {
      case "status":
        data = await core.getOverview();
        break;
      case "credentials-test":
        data = await core.testCredentials();
        break;
      case "settings":
        data = await core.getSettings();
        break;
      case "gpus":
        data = await core.listGpuTypes();
        break;
      case "datacenters":
        data = await core.listDataCenters();
        break;
      case "volumes":
        data = await core.listNetworkVolumes();
        break;
      case "templates":
        data = await core.listTemplates();
        break;
      case "template-create":
        data = await core.createTemplate(await readJsonFile(readFileText, parsed.flags));
        break;
      case "cpus":
        data = await core.listCpuTypes();
        break;
      case "volume-create":
        data = await core.createNetworkVolume({
          name: requireFlag(parsed.flags, "name"),
          datacenterId: requireFlag(parsed.flags, "dc"),
          sizeGb: Number(requireFlag(parsed.flags, "size")),
        });
        break;
      case "pods":
        data = await core.listPods();
        break;
      case "pod-get":
        data = await core.getPod(requirePositional(parsed.positional, 0, "podId"));
        break;
      case "pod-create":
        data = await core.createPod(await readJsonFile(readFileText, parsed.flags));
        break;
      case "pod-terminate":
        data = await core.terminatePod(requirePositional(parsed.positional, 0, "podId"));
        break;
      case "s3-ls":
        data = await (await core.s3()).listAllObjects(parsed.positional[0] ?? "");
        break;
      case "s3-get":
        data = await (await core.s3()).getObjectToFile(requirePositional(parsed.positional, 0, "key"), requirePositional(parsed.positional, 1, "dest"));
        break;
      case "s3-put": {
        const file = requirePositional(parsed.positional, 0, "file");
        const key = requirePositional(parsed.positional, 1, "key");
        const bytes = await (args.readFileBytes ?? ((p: string) => readFile(p)))(file);
        await (await core.s3()).putObject(key, bytes);
        data = { uploaded: key, bytes: bytes.byteLength };
        break;
      }
      case "s3-rm":
        await (await core.s3()).deleteObject(requirePositional(parsed.positional, 0, "key"));
        data = { deleted: parsed.positional[0] };
        break;
    }
    writeStdout(serialize({ ok: true, data }));
    return 0;
  } catch (error) {
    if (error instanceof DomainError) {
      writeStdout(serialize({ ok: false, error: { code: error.code, message: error.message, details: error.details } }));
      return 1;
    }
    if (error instanceof OperationLockError || error instanceof RecoveryModeError) {
      writeStdout(serialize({ ok: false, error: { code: "device_unavailable", message: error.message } }));
      return 1;
    }
    writeStdout(serialize({ ok: false, error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } }));
    return 1;
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  runMediaCli({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
