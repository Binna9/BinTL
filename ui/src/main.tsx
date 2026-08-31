import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import { GlobalLoadingOverlay } from "@/components/GlobalLoadingOverlay";
import { GlobalNotifications } from "@/components/GlobalNotifications";
import { ViewTransitionLocationProvider } from "@/hooks/useViewTransitionLocation";
import { LanguageProvider } from "@/i18n/LanguageProvider";
import { applyTheme, getPreferredTheme } from "@/lib/theme";

applyTheme(getPreferredTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider>
      <BrowserRouter>
        <ViewTransitionLocationProvider>
          <App />
        </ViewTransitionLocationProvider>
      </BrowserRouter>
      <GlobalNotifications />
      <GlobalLoadingOverlay />
    </LanguageProvider>
  </StrictMode>,
);
