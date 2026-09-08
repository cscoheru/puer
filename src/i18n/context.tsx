"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { t, LOCALE_COOKIE, DEFAULT_LOCALE, toggleLocale } from "./translations";
import type { Locale } from "./translations";

interface I18nContextType {
  locale: Locale;
  setLocale: (l: Locale) => void;
  toggle: () => void;
  _(key: string): string;
}

const I18nContext = createContext<I18nContextType>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  toggle: () => {},
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
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof document === "undefined") return initialLocale || DEFAULT_LOCALE;
    return (getCookie(LOCALE_COOKIE) as Locale) || initialLocale || DEFAULT_LOCALE;
  });

  useEffect(() => {
    setCookie(LOCALE_COOKIE, locale);
  }, [locale]);

  const setLocale = useCallback((l: Locale) => setLocaleState(l), []);
  const toggle = useCallback(() => setLocaleState((prev) => toggleLocale(prev)), []);
  const _ = useCallback((key: string) => t(key, locale), [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, toggle, _ }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useLocale() {
  return useContext(I18nContext);
}
