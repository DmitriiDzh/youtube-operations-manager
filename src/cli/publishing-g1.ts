#!/usr/bin/env node

import { loadEnvConfig } from "@next/env";
import { listChannelConnections } from "@/lib/channel-fanout";
import { createG1ProbeCore } from "@/lib/publishing";

// BL-182 stage 0 (ADR 0037 §7): the developer-only G1 probe. Not reachable from the Web UI, MCP or the Producer. It runs once, on
// the owner's yes (Telegram msg 2702):
//   upload --channel <channelId> --file "<path relative to the channel workspace>" --i-understand-this-uploads [--retry-after-duplicate]
//   delete --channel <channelId> --video <videoId> --i-understand-this-deletes
// The channel's own connected Google user is the credential; the identity check, the recovery gate and Live writes apply as for
// every write. Output is JSON on stdout.

loadEnvConfig(process.cwd());

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

const G1_METADATA = {
  title: "TEST upload check FO-REQ-0023 (private, will be deleted)",
  description: "Internal API upload test. Will be deleted.",
};

async function userIdOf(channelId: string): Promise<string> {
  const connection = (await listChannelConnections()).find((c) => c.channelId === channelId);
  if (!connection?.connectedUserId) throw new Error(`No Google account is connected for ${channelId} on this computer.`);
  return connection.connectedUserId;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  // The video id goes to stderr the moment YouTube returns it, before anything else can fail (review S3).
  const probe = createG1ProbeCore({ announce: (videoId) => process.stderr.write(`uploaded: ${videoId}\n`) });
  if (command === "upload") {
    if (!args.includes("--i-understand-this-uploads")) throw new Error("Refusing: pass --i-understand-this-uploads (a real YouTube upload).");
    const channelId = flag(args, "--channel");
    const relativePath = flag(args, "--file");
    if (!channelId || !relativePath) throw new Error('Usage: upload --channel <channelId> --file "<relative path>" --i-understand-this-uploads');
    const report = await probe.upload({
      credentialRef: { userId: await userIdOf(channelId) },
      channelId,
      relativePath,
      retryAfterDuplicate: args.includes("--retry-after-duplicate"),
      resource: {
        snippet: { ...G1_METADATA, defaultLanguage: "en", defaultAudioLanguage: "en" },
        status: { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
      },
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (command === "delete") {
    if (!args.includes("--i-understand-this-deletes")) throw new Error("Refusing: pass --i-understand-this-deletes (a real YouTube delete).");
    const videoId = flag(args, "--video");
    const channelId = flag(args, "--channel");
    if (!videoId || !channelId) throw new Error("Usage: delete --channel <channelId> --video <videoId> --i-understand-this-deletes");
    const report = await probe.remove({ credentialRef: { userId: await userIdOf(channelId) }, videoId });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  throw new Error("Commands: upload | delete");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const shown = error as { code?: unknown; message?: unknown; details?: unknown };
    process.stderr.write(`${JSON.stringify({ error: shown?.code ?? "error", message: String(shown?.message ?? error), details: shown?.details ?? null })}\n`);
    process.exit(1);
  }
);
