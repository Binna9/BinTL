import { useCallback, useEffect, useState } from "react";
import { connectionApi } from "@/services/connectionApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import type {
  CatalogSelection,
  DatabaseColumn,
} from "@/types/connection";

export function useConnectionColumns(
  connectionId: string,
  selection: CatalogSelection | null,
) {
  const { messages } = useLanguage();
  const [connectionColumns, setConnectionColumns] = useState<DatabaseColumn[]>([]);
  const [connectionColumnsError, setConnectionColumnsError] = useState("");
  const [columnsLoading, setColumnsLoading] = useState(false);

  const refreshColumns = useCallback(async () => {
    if (!connectionId || !selection) {
      setConnectionColumns([]);
      setConnectionColumnsError("");
      return [];
    }

    setColumnsLoading(true);
    try {
      const response = await connectionApi.getColumns(
        connectionId,
        selection.qualified,
        selection.database,
      );
      setConnectionColumns(response.columns);
      setConnectionColumnsError("");
      return response.columns;
    } catch (error) {
      setConnectionColumns([]);
      setConnectionColumnsError(
        error instanceof Error ? error.message : messages.errors.columns,
      );
      return null;
    } finally {
      setColumnsLoading(false);
    }
  }, [connectionId, selection, messages]);

  useEffect(() => {
    void refreshColumns();
  }, [refreshColumns]);

  return {
    connectionColumns,
    connectionColumnsError,
    columnsLoading,
    refreshColumns,
  };
}
