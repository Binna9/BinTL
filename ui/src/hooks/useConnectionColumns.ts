import { useEffect, useState } from "react";
import { connectionApi } from "@/services/connectionApi";
import type {
  CatalogSelection,
  DatabaseColumn,
} from "@/types/connection";

export function useConnectionColumns(
  connectionId: string,
  selection: CatalogSelection | null,
) {
  const [connectionColumns, setConnectionColumns] = useState<DatabaseColumn[]>([]);
  const [connectionColumnsError, setConnectionColumnsError] = useState("");

  useEffect(() => {
    if (!connectionId || !selection) {
      setConnectionColumns([]);
      setConnectionColumnsError("");
      return;
    }

    void connectionApi
      .getColumns(connectionId, selection.qualified, selection.database)
      .then((response) => {
        setConnectionColumns(response.columns);
        setConnectionColumnsError("");
      })
      .catch((error) => {
        setConnectionColumns([]);
        setConnectionColumnsError(
          error instanceof Error ? error.message : "컬럼을 불러오지 못했습니다",
        );
      });
  }, [connectionId, selection]);

  return { connectionColumns, connectionColumnsError };
}
