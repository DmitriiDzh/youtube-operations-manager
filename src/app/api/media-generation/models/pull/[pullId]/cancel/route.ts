import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaParamsHandler, type MediaRouteDeps } from "../../../../shared";

export function createModelPullCancelHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaParamsHandler<{ pullId: string }>(deps, async ({ core, params }) => NextResponse.json({ pull: await core.cancelPull({ pullId: params.pullId }) }));
}

export const POST = createModelPullCancelHandler();
