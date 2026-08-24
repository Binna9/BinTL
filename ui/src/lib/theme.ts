import type { ColorTheme } from "@/types/theme";

export const THEME_STORAGE_KEY = "bintl.color-theme";

export function getStoredTheme(): ColorTheme | null {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

export function getPreferredTheme(): ColorTheme {
  return (
    getStoredTheme() ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
}

export function applyTheme(theme: ColorTheme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function storeTheme(theme: ColorTheme): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}
