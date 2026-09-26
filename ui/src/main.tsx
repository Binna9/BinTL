import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import "./styles.css";
import { GlobalLoadingOverlay } from "@/components/GlobalLoadingOverlay";
import { GlobalNotifications } from "@/components/GlobalNotifications";
import { AppNavigationProvider } from "@/hooks/useAppNavigation";
import { ViewTransitionLocationProvider } from "@/hooks/useViewTransitionLocation";
import { LanguageProvider } from "@/i18n/LanguageProvider";
import { applyTheme, getPreferredTheme } from "@/lib/theme";

const CHUNK_RELOAD_KEY = "bintl:stale-chunk-reload";

function recoverFromStaleChunk() {
  const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
  if (Date.now() - lastReload < 15_000) return;
  sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  window.location.reload();
}

function isStaleChunkError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  return /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i.test(message);
}

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  recoverFromStaleChunk();
});

window.addEventListener("unhandledrejection", (event) => {
  if (!isStaleChunkError(event.reason)) return;
  event.preventDefault();
  recoverFromStaleChunk();
});

window.setTimeout(() => sessionStorage.removeItem(CHUNK_RELOAD_KEY), 15_000);

applyTheme(getPreferredTheme());

function RoutedApp() {
  return (
    <LanguageProvider>
      <AppNavigationProvider>
        <ViewTransitionLocationProvider>
          <App />
        </ViewTransitionLocationProvider>
      </AppNavigationProvider>
      <GlobalNotifications />
      <GlobalLoadingOverlay />
    </LanguageProvider>
  );
}

const router = createBrowserRouter([
  { path: "*", element: <RoutedApp /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
