import { NextResponse } from "next/server";
import { weeklyTemplateState } from "@/composition/weekly-build-template";
import { defaultWeeklyBuildRouteDeps, weeklyBuildHandler } from "../shared";

// BL-267 (owner O7): whether «Собрать неделю по шаблону» is offered (a music template in force) and the template itself.
export const GET = weeklyBuildHandler(defaultWeeklyBuildRouteDeps(), async ({ channelId }) => NextResponse.json(await weeklyTemplateState(channelId)));
