import { useCallback, useEffect, useState } from "react";
import { connectionApi } from "@/services/connectionApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
import type { DataConnection } from "@/types/connection";

export function useConnections() {
  const { messages } = useLanguage();
  const [connections, setConnections] = useState<DataConnection[]>([]);

  const refreshConnections = useCallback(async () => {
    const response = await connectionApi.getConnections();
    setConnections(response.connections);
  }, []);

  useEffect(() => {
    void refreshConnections().catch((error) =>
      toastError(messages.errors.connections, error),
    );
  }, [refreshConnections, messages]);

  return {
    connections,
    refreshConnections,
  };
}
