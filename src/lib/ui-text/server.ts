import { cookies, headers } from "next/headers";
import { resolveUiLanguage, UI_LANGUAGE_COOKIE, type ResolvedUiLanguage } from "./index";

// BL-152: the interface language of the current request, for server components (the root layout). No database read --
// see `UI_LANGUAGE_COOKIE`.
export async function requestUiLanguage(): Promise<ResolvedUiLanguage> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  return resolveUiLanguage({
    cookie: cookieStore.get(UI_LANGUAGE_COOKIE)?.value,
    acceptLanguage: headerList.get("accept-language"),
  });
}
