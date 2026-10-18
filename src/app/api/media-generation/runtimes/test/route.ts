import { NextResponse } from "next/server";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { DomainError } from "@/lib/media-generation";
import { assertConnectedChannel, bodyRecord, defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../../shared";

/**
 * BL-200 (AC-RT-05): the owner tests a runtime -- a CPU build if it is not built, then a short GPU session (approved as the owner,
 * capped by runtimeTestMaxUsd) and the node check. Billed. The session is booked to `channelId`, else the first connected channel.
 */
export function createRuntimeTestPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps(), listChannels: () => Promise<Array<{ channelId: string }>> = () => createChannelConnectionsCore().listConnectedChannels()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = bodyRecord(body.body);
    if (typeof input.runtimeId !== "string") throw new DomainError({ code: "validation_failed", message: "runtimeId is required", details: { field: "runtimeId" } });
    let channelId: string;
    if (input.channelId !== undefined) {
      await assertConnectedChannel(deps, input.channelId);
      channelId = input.channelId as string;
    } else {
      const first = (await listChannels())[0];
      if (!first) throw new DomainError({ code: "channel_not_connected", message: "A runtime test needs a connected channel to book its session to (Settings → Channels)." });
      channelId = first.channelId;
    }
    const templateIds = Array.isArray(input.templateIds) ? input.templateIds.filter((id): id is string => typeof id === "string") : undefined;
    return NextResponse.json({ test: await core.testRuntime({ runtimeId: input.runtimeId, channelId, ...(templateIds ? { templateIds } : {}) }, { actor: "owner" }) }, { status: 201 });
  });
}

export const POST = createRuntimeTestPostHandler();
