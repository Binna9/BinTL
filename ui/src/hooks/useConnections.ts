import { useCallback, useEffect, useState } from "react";
import { connectionApi } from "@/services/connectionApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { DataConnection } from "@/types/connection";

export function useConnections() {
  const { messages } = useLanguage();
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [connectionsError, setConnectionsError] = useState("");

  const refreshConnections = useCallback(async () => {
    const response = await connectionApi.getConnections();
    setConnections(response.connections);
  }, []);

  useEffect(() => {
    void refreshConnections().catch((error) =>
      setConnectionsError(
        error instanceof Error ? error.message : messages.errors.connections,
      ),
    );
  }, [refreshConnections, messages]);

  return {
    connections,
    connectionsError,
    setConnectionsError,
    refreshConnections,
  };
}
