"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { usePathname } from "next/navigation";
import { t, isTwPath, parseLocale, LOCALE_COOKIE, DEFAULT_LOCALE } from "./translations";
import type { Locale } from "./translations";

interface I18nContextType {
  locale: Locale;
  setLocale: (l: Locale) => void;
  _(key: string): string;
}

const I18nContext = createContext<I18nContextType>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  _: (key: string) => key,
});

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(`(?:^|;\\s*)${name}=([^;]*)`);
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=31536000;SameSite=Lax`;
}

export function I18nProvider({ children, initialLocale }: { children: React.ReactNode; initialLocale?: Locale }) {
  const pathname = usePathname();
  // A mirrored URL outranks the cookie. Arriving at /tw/... *is* the request
  // for traditional — a reader who browsed the simplified site last month
  // still has `puer-locale=zh-CN` in a one-year cookie, and letting that win
  // would render the traditional page in simplified chrome. Derived during
  // render (not stored in state) so it also tracks client-side navigation
  // between the two trees, which the server-provided initialLocale cannot.
  //
  // `isTwPath` is imported rather than re-implemented: src/proxy.ts makes the
  // same call server-side to set x-puer-locale, and the two must agree.
  const forcedLocale: Locale | null = isTwPath(pathname) ? "zh-TW" : null;

  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof document === "undefined") return initialLocale || DEFAULT_LOCALE;
    return parseLocale(getCookie(LOCALE_COOKIE)) || initialLocale || DEFAULT_LOCALE;
  });

  const effectiveLocale = forcedLocale ?? locale;

  // The root layout sets <html lang> from the x-puer-locale header, which is
  // only correct for the *initial* document. A soft navigation between the two
  // trees does not re-render the layout, so the attribute would keep announcing
  // the language the reader arrived with — to screen readers, to the browser's
  // own translation prompt, and to anything else reading the DOM.
  useEffect(() => {
    document.documentElement.lang = effectiveLocale;
  }, [effectiveLocale]);

  useEffect(() => {
    // Only a deliberate choice gets persisted. Writing the cookie while the
    // reader is inside /tw/... would also pin every *simplified* page they
    // visit afterwards to traditional, because the cookie is global and
    // long-lived — the /tw/ prefix is a per-page decision, the cookie is not.
    if (forcedLocale) return;
    setCookie(LOCALE_COOKIE, locale);
  }, [locale, forcedLocale]);

  // Deliberately NOT guarded by `forcedLocale`. Inside /tw/... this has no
  // visible effect (`effectiveLocale` is forced), but the value still has to be
  // recorded: the provider lives in the root layout and is never remounted, so
  // when the reader leaves the tree this state is what the simplified page
  // reads. Guarding it here is what would strand traditional chrome on a
  // simplified URL. The cookie stays untouched — the effect above skips it.
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
  }, []);
  const _ = useCallback((key: string) => t(key, effectiveLocale), [effectiveLocale]);

  return (
    <I18nContext.Provider value={{ locale: effectiveLocale, setLocale, _ }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useLocale() {
  return useContext(I18nContext);
}
