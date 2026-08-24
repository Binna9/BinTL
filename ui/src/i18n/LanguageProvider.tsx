import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
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
      setLocale,
      toggleLocale: () => setLocale((current) => (current === "ko" ? "en" : "ko")),
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
