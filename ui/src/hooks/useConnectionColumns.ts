import { useEffect, useState } from "react";
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
          error instanceof Error ? error.message : messages.errors.columns,
        );
      });
  }, [connectionId, selection, messages]);

  return { connectionColumns, connectionColumnsError };
}
