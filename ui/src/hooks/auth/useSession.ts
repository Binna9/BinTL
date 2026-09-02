import { createContext, createElement, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { userApi } from "@/services/auth/userApi";
import type { SessionUser } from "@/types/user";

type SessionContextValue = {
  user: SessionUser | null;
  loading: boolean;
  canManageUsers: boolean;
  canWriteConnections: boolean;
  refresh: () => Promise<void>;
  clearSession: () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const next = await userApi.me();
      setUser(next);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function clearSession() {
    setUser(null);
    setLoading(false);
  }

  const value = useMemo<SessionContextValue>(
    () => ({
      user,
      loading,
      canManageUsers: user?.permissions.includes("USER_MANAGE") ?? false,
      canWriteConnections: user?.permissions.includes("CONNECTION_WRITE") ?? false,
      refresh,
      clearSession,
    }),
    [user, loading],
  );

  return createElement(SessionContext.Provider, { value }, children);
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return value;
}
