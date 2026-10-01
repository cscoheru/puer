/**
 * Which language the *request* is in, for server components that render DB text.
 *
 * Inside `/tw/...` the URL decides (src/proxy.ts stamps `x-puer-locale`), and
 * outside it the cookie does — the same split the client provider implements in
 * src/i18n/context.tsx. On a simplified page the two can differ: a reader whose
 * cookie says zh-TW is reading simplified URLs with traditional chrome, and
 * every server component on that page has to agree with the header, the feed and
 * the sidebar about that, or the page renders half in each language.
 *
 * The header is how the URL's opinion reaches these components, not a second
 * `isTwPath(pathname)` call: they are not given their pathname, and re-deriving
 * it would be a third copy of the predicate that can drift. It is a *force*
 * signal only — see {@link pickLocale} for why "zh-CN" on it is not a decision.
 */
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, DEFAULT_LOCALE, pickLocale } from "@/i18n/translations";
import type { Locale } from "@/i18n/translations";

export async function resolveRequestLocale(): Promise<Locale> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  // The asymmetry between the two sources — the URL forces zh-TW and says
  // nothing else, the cookie decides the rest — is documented on pickLocale.
  return (
    pickLocale(headerList.get("x-puer-locale"), cookieStore.get(LOCALE_COOKIE)?.value) ??
    DEFAULT_LOCALE
  );
}
