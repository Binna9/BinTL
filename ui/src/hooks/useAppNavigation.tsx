import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { registerAppNavigate, unregisterAppNavigate } from "@/lib/navigation";

/** Registers React Router navigate for non-component code (e.g. httpClient). */
export function AppNavigationProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  useEffect(() => {
    registerAppNavigate(navigate);
    return unregisterAppNavigate;
  }, [navigate]);

  return children;
}
