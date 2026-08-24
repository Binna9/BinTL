import { useCallback, useEffect, useState } from "react";
import { connectionApi } from "@/services/connectionApi";
import type { DataConnection } from "@/types/connection";

export function useConnections() {
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [connectionsError, setConnectionsError] = useState("");

  const refreshConnections = useCallback(async () => {
    const response = await connectionApi.getConnections();
    setConnections(response.connections);
  }, []);

  useEffect(() => {
    void refreshConnections().catch((error) =>
      setConnectionsError(
        error instanceof Error ? error.message : "커넥션 목록을 불러오지 못했습니다",
      ),
    );
  }, [refreshConnections]);

  return {
    connections,
    connectionsError,
    setConnectionsError,
    refreshConnections,
  };
}
