import { useEffect, useState } from "react";
import { connectionApi } from "@/services/connectionApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import type {
  CatalogEntry,
  CatalogLayout,
} from "@/types/connection";

export function useConnectionCatalog(connectionId: string) {
  const { messages } = useLanguage();
  const [catalogLayout, setCatalogLayout] =
    useState<CatalogLayout>("database.schema.table");
  const [databases, setDatabases] = useState<CatalogEntry[]>([]);
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({});
  const [nodeChildren, setNodeChildren] = useState<
    Record<string, CatalogEntry[]>
  >({});
  const [catalogError, setCatalogError] = useState("");
  const [loadingNode, setLoadingNode] = useState("");

  useEffect(() => {
    setDatabases([]);
    setOpenNodes({});
    setNodeChildren({});
    setCatalogError("");
    void connectionApi
      .getDatabases(connectionId)
      .then((response) => {
        setCatalogLayout(response.layout);
        setDatabases(response.databases);
      })
      .catch((error) =>
        setCatalogError(
          error instanceof Error ? error.message : messages.errors.catalog,
        ),
      );
  }, [connectionId, messages]);

  async function toggleNode(
    nodeKey: string,
    loader: () => Promise<CatalogEntry[]>,
  ) {
    if (openNodes[nodeKey]) {
      setOpenNodes((current) => ({ ...current, [nodeKey]: false }));
      return;
    }
    if (!nodeChildren[nodeKey]) {
      setLoadingNode(nodeKey);
      try {
        const items = await loader();
        setNodeChildren((current) => ({ ...current, [nodeKey]: items }));
        setCatalogError("");
      } catch (error) {
        setCatalogError(
          error instanceof Error ? error.message : messages.errors.list,
        );
        setLoadingNode("");
        return;
      }
      setLoadingNode("");
    }
    setOpenNodes((current) => ({ ...current, [nodeKey]: true }));
  }

  function toggleDatabase(database: CatalogEntry) {
    const nodeKey = `db:${database.name}`;
    void toggleNode(nodeKey, async () => {
      if (catalogLayout === "database.schema.table") {
        const response = await connectionApi.getSchemas(connectionId, database.name);
        return response.schemas;
      }
      const response = await connectionApi.getRelations(connectionId, database.name);
      return response.tables;
    });
  }

  function toggleSchema(database: string, schema: CatalogEntry) {
    const nodeKey = `sc:${database}.${schema.name}`;
    void toggleNode(nodeKey, async () => {
      const response = await connectionApi.getRelations(
        connectionId,
        database,
        schema.name,
      );
      return response.tables;
    });
  }

  return {
    catalogLayout,
    databases,
    openNodes,
    nodeChildren,
    catalogError,
    loadingNode,
    toggleDatabase,
    toggleSchema,
  };
}
