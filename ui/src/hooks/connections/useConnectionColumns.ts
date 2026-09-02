import { useCallback, useEffect, useState } from "react";
import { connectionApi } from "@/services/connections/connectionApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
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
  const [columnsLoading, setColumnsLoading] = useState(false);

  const refreshColumns = useCallback(async () => {
    if (!connectionId || !selection) {
      setConnectionColumns([]);
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
      return response.columns;
    } catch (error) {
      setConnectionColumns([]);
      toastError(messages.errors.columns, error);
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
    columnsLoading,
    refreshColumns,
  };
}
