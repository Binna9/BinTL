import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { selectableClass } from "@/lib/selectable";
import type { CatalogItem, CatalogLayout, CatalogPick } from "@/types/pipeline";

function qualifiedName(layout: CatalogLayout, _database: string, schema: string | null, table: string) {
  if (layout === "database.schema.table") {
    return schema ? `${schema}.${table}` : table;
  }
  return table;
}

function KindIcon({ kind }: { kind: CatalogItem["kind"] }) {
  if (kind === "database") {
    return (
      <svg className="size-3.5 shrink-0 text-accent" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <ellipse cx="8" cy="4.2" rx="5.2" ry="2.1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2.8 4.2v7.5c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V4.2" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2.8 8s2.2 1.7 5.2 1.7 5.2-1.7 5.2-1.7" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    );
  }
  if (kind === "schema") {
    return (
      <svg className="size-3.5 shrink-0 text-text-secondary" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2.5 13.2V5.4c0-.5.4-.9.9-.9h3.1L8 5.8h4.6c.5 0 .9.4.9.9v6.5c0 .5-.4.9-.9.9H3.4c-.5 0-.9-.4-.9-.9Z"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
    );
  }
  return (
    <svg className="size-3.5 shrink-0 text-success" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 6.2h12M2 9.4h12M6.2 6.2V13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function RowButton({
  depth,
  open,
  expandable,
  active,
  kind,
  name,
  current,
  onClick,
}: {
  depth: number;
  open?: boolean;
  expandable?: boolean;
  active?: boolean;
  kind: CatalogItem["kind"];
  name: string;
  current?: boolean | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={name}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden pr-2 text-left",
        selectableClass(active),
      )}
    >
      <span
        className={cn(
          "grid size-3 shrink-0 place-items-center text-[9px] text-text-tertiary transition-transform",
          expandable ? (open ? "rotate-90" : "") : "opacity-0",
        )}
      >
        ▶
      </span>
      <KindIcon kind={kind} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[12px]",
          active ? "font-medium text-accent" : "text-text",
        )}
      >
        {name}
      </span>
      {current ? <span className="ml-1 shrink-0 text-[10px] text-text-tertiary">현재</span> : null}
    </button>
  );
}

export function CatalogTree({
  connectionId,
  selected,
  onPick,
}: {
  connectionId: string;
  selected?: CatalogPick | null;
  onPick: (pick: CatalogPick | null) => void;
}) {
  const [layout, setLayout] = useState<CatalogLayout>("database.schema.table");
  const [databases, setDatabases] = useState<CatalogItem[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [children, setChildren] = useState<Record<string, CatalogItem[]>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");

  useEffect(() => {
    setDatabases([]);
    setOpen({});
    setChildren({});
    setError("");
    void api
      .connectionDatabases(connectionId)
      .then((response) => {
        setLayout(response.layout);
        setDatabases(response.databases);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "카탈로그를 불러오지 못했습니다"));
  }, [connectionId]);

  async function toggle(key: string, loader: () => Promise<CatalogItem[]>) {
    if (open[key]) {
      setOpen((current) => ({ ...current, [key]: false }));
      return;
    }
    if (!children[key]) {
      setLoading(key);
      try {
        const items = await loader();
        setChildren((current) => ({ ...current, [key]: items }));
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다");
        setLoading("");
        return;
      }
      setLoading("");
    }
    setOpen((current) => ({ ...current, [key]: true }));
  }

  function onDatabase(item: CatalogItem) {
    const key = `db:${item.name}`;
    void toggle(key, async () => {
      if (layout === "database.schema.table") {
        const response = await api.connectionSchemas(connectionId, item.name);
        return response.schemas;
      }
      const response = await api.connectionRelations(connectionId, item.name);
      return response.tables;
    });
  }

  function onSchema(database: string, item: CatalogItem) {
    const key = `sc:${database}.${item.name}`;
    void toggle(key, async () => {
      const response = await api.connectionRelations(connectionId, database, item.name);
      return response.tables;
    });
  }

  function onTable(database: string, schema: string | null, item: CatalogItem) {
    const pick: CatalogPick = {
      database,
      schema,
      table: item.name,
      qualified: qualifiedName(layout, database, schema, item.name),
    };
    if (selected?.qualified === pick.qualified && selected.database === pick.database) {
      onPick(null);
      return;
    }
    onPick(pick);
  }

  if (error) {
    return <p className="p-3 text-xs text-danger">{error}</p>;
  }
  if (databases.length === 0) {
    return <p className="p-3 text-xs text-text-tertiary">데이터베이스를 불러오는 중이거나 없습니다.</p>;
  }

  return (
    <div className="py-1">
      {databases.map((database) => {
        const dbKey = `db:${database.name}`;
        const dbOpen = Boolean(open[dbKey]);
        const dbKids = children[dbKey] ?? [];
        return (
          <div key={dbKey}>
            <RowButton
              depth={0}
              expandable
              open={dbOpen}
              kind="database"
              name={database.name}
              current={database.current}
              onClick={() => onDatabase(database)}
            />
            {loading === dbKey ? (
              <p className="px-8 py-1 text-[11px] text-text-tertiary">불러오는 중…</p>
            ) : null}
            {dbOpen
              ? dbKids.map((child) => {
                  if (child.kind === "schema") {
                    const scKey = `sc:${database.name}.${child.name}`;
                    const scOpen = Boolean(open[scKey]);
                    const tables = children[scKey] ?? [];
                    return (
                      <div key={scKey}>
                        <RowButton
                          depth={1}
                          expandable
                          open={scOpen}
                          kind="schema"
                          name={child.name}
                          onClick={() => onSchema(database.name, child)}
                        />
                        {loading === scKey ? (
                          <p className="px-10 py-1 text-[11px] text-text-tertiary">불러오는 중…</p>
                        ) : null}
                        {scOpen
                          ? tables.map((table) => {
                              const qualified = qualifiedName(layout, database.name, child.name, table.name);
                              return (
                                <RowButton
                                  key={`${scKey}.${table.name}`}
                                  depth={2}
                                  kind={table.kind}
                                  name={table.name}
                                  active={selected?.qualified === qualified && selected.database === database.name}
                                  onClick={() => onTable(database.name, child.name, table)}
                                />
                              );
                            })
                          : null}
                      </div>
                    );
                  }
                  const qualified = qualifiedName(layout, database.name, null, child.name);
                  return (
                    <RowButton
                      key={`${dbKey}.${child.name}`}
                      depth={1}
                      kind={child.kind}
                      name={child.name}
                      active={selected?.qualified === qualified && selected.database === database.name}
                      onClick={() => onTable(database.name, null, child)}
                    />
                  );
                })
              : null}
          </div>
        );
      })}
    </div>
  );
}
