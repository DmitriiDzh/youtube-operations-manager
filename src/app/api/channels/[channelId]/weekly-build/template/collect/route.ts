import { NextResponse } from "next/server";
import { collectWeeklyTemplateBuild } from "@/composition/weekly-build-template";
import { defaultWeeklyBuildRouteDeps, weeklyBuildHandler } from "../../shared";

// BL-267 (owner O7): POST -- a finished template build's payloads saved as the factory, then `13 push --sent` for the accepted ones.
export const POST = weeklyBuildHandler(defaultWeeklyBuildRouteDeps(), async ({ channelId }) => NextResponse.json({ collected: await collectWeeklyTemplateBuild(channelId) }));
