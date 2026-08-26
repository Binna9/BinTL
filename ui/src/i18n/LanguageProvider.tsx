import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { en } from "./en";
import { ko, type Messages } from "./ko";

export type Locale = "ko" | "en";

interface LanguageContextValue {
  locale: Locale;
  messages: Messages;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
}

const STORAGE_KEY = "bintl.locale";
const LanguageContext = createContext<LanguageContextValue | null>(null);

function preferredLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "ko" || stored === "en") return stored;
  return navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function applyLocale(next: Locale, setLocale: (locale: Locale) => void) {
  flushSync(() => setLocale(next));
}

function withLocaleTransition(apply: () => void) {
  const startViewTransition = document.startViewTransition?.bind(document);
  if (startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    startViewTransition(apply);
    return;
  }
  apply();
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(preferredLocale);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      locale,
      messages: locale === "ko" ? ko : en,
      setLocale: (next) => {
        if (next === locale) return;
        withLocaleTransition(() => applyLocale(next, setLocale));
      },
      toggleLocale: () => {
        const next = locale === "ko" ? "en" : "ko";
        withLocaleTransition(() => applyLocale(next, setLocale));
      },
    }),
    [locale],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage must be used within LanguageProvider");
  return value;
}
