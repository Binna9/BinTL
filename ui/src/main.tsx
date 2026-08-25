import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import { GlobalNotifications } from "@/components/GlobalNotifications";
import { LanguageProvider } from "@/i18n/LanguageProvider";
import { applyTheme, getPreferredTheme } from "@/lib/theme";

applyTheme(getPreferredTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <GlobalNotifications />
    </LanguageProvider>
  </StrictMode>,
);
