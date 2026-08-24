import { useEffect, useState } from "react";
import {
  applyTheme,
  getPreferredTheme,
  getStoredTheme,
  storeTheme,
  THEME_STORAGE_KEY,
} from "@/lib/theme";
import type { ColorTheme } from "@/types/theme";

export function useTheme() {
  const [theme, setTheme] = useState<ColorTheme>(getPreferredTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = (event: MediaQueryListEvent) => {
      if (!getStoredTheme()) setTheme(event.matches ? "dark" : "light");
    };
    const onStorageChange = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setTheme(getPreferredTheme());
    };

    media.addEventListener("change", onSystemThemeChange);
    window.addEventListener("storage", onStorageChange);
    return () => {
      media.removeEventListener("change", onSystemThemeChange);
      window.removeEventListener("storage", onStorageChange);
    };
  }, []);

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    storeTheme(nextTheme);
    setTheme(nextTheme);
  }

  return { theme, toggleTheme };
}
