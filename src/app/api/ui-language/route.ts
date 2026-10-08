import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isUiLanguage, UI_LANGUAGE_COOKIE } from "@/lib/ui-text";

// BL-152 (docs/roadmap/plans/UI_LANGUAGE_PLAN.md): the interface language choice of this browser on this computer
// (owner, msg 2032, Q1). `{ language: "ru" }` chooses a language; `{ language: null }` goes back to the system language.
// A cookie only -- the database is never touched, so the root layout can read it on every page, recovery included.

const TEN_YEARS_SECONDS = 10 * 365 * 24 * 60 * 60;

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const language = typeof body === "object" && body !== null && "language" in body ? body.language : undefined;
  if (language !== null && !isUiLanguage(language)) {
    return NextResponse.json({ error: "INVALID_UI_LANGUAGE", message: "language must be a supported interface language or null" }, { status: 400 });
  }

  const store = await cookies();
  if (language === null) store.delete(UI_LANGUAGE_COOKIE);
  // The app is served over plain http://127.0.0.1, so the cookie must not be `secure` or the browser would never send it.
  else store.set(UI_LANGUAGE_COOKIE, language, { httpOnly: true, sameSite: "lax", path: "/", maxAge: TEN_YEARS_SECONDS });
  return NextResponse.json({ language });
}
