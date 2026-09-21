import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SUPPORTED_YOUTUBE_LANGUAGES } from "@/lib/youtube-supported-languages";

// Hardcoded, not a live YouTube API call (owner instruction, 2026-09-21: "не дергать по этому
// поводу API лишний раз") -- see src/lib/youtube-supported-languages.ts's own doc comment for
// where this list came from and its known limitation. This is now the hard allowlist for the
// Languages tab's "Add language column" feature, enforced server-side in
// localization/services.ts's addTrackedLanguage, not just a suggestion source.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ languages: SUPPORTED_YOUTUBE_LANGUAGES });
}
