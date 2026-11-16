import { NextResponse } from "next/server";
import { startWeeklyBuildByTemplate } from "@/composition/weekly-build-template";
import { defaultWeeklyBuildRouteDeps, weeklyBuildHandler } from "../../shared";

// BL-267 (owner O7): POST `{ week? }` -- writes the template in force and starts `13 auto --template [--week W]`.
export const POST = weeklyBuildHandler(defaultWeeklyBuildRouteDeps(), async ({ channelId, request }) => {
  const body = (await request.json().catch(() => ({}))) as { week?: unknown };
  return NextResponse.json(await startWeeklyBuildByTemplate(channelId, typeof body?.week === "string" ? body.week : null));
});
