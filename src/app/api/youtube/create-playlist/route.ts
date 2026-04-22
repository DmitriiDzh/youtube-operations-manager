import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createPlaylist } from "@/lib/youtube";

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { title, privacyStatus } = await request.json();
  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const playlist = await createPlaylist(
    session.user.id,
    title.trim(),
    privacyStatus ?? "private"
  );

  return NextResponse.json(playlist, { status: 201 });
}
