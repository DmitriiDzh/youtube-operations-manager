import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../shared";

// BL-200 (FO-REQ-0029, ADR 0043): Servers → Setup → Pod runtimes. The profiles on the network volume, with this computer's builds
// and tests of them. Read-only; the build and the test are started by POST runtimes/test, the active one set by runtimes/activate.
export function createRuntimesGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => {
    const [list, builds, tests] = await Promise.all([core.listRuntimes(), core.listRuntimeBuilds(), core.listRuntimeTests()]);
    return NextResponse.json({ ...list, builds: builds.slice(-50), tests: tests.slice(-50) });
  });
}

export const GET = createRuntimesGetHandler();
