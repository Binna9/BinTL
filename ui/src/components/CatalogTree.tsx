import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import type { CatalogItem, CatalogLayout, CatalogPick } from "@/types/pipeline";

function qualifiedName(layout: CatalogLayout, _database: string, schema: string | null, table: string) {
  if (layout === "database.schema.table") {
    return schema ? `${schema}.${table}` : table;
  }
  return table;
}

function KindBadge({ kind }: { kind: CatalogItem["kind"] }) {
  const map = {
    database: { label: "DB", className: "bg-accent-subtle text-accent" },
    schema: { label: "스키마", className: "bg-subtle text-text-secondary" },
    table: { label: "테이블", className: "bg-success-subtle text-success" },
    view: { label: "뷰", className: "bg-warning-subtle text-warning" },
  } as const;
  const item = map[kind];
  return (
    <span className={cn("rounded px-1 py-px text-[9px] font-semibold tracking-wide", item.className)}>
      {item.label}
    </span>
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
      style={{ paddingLeft: 8 + depth * 14 }}
      className={cn(
        "flex h-8 w-full items-center gap-1.5 pr-2 text-left",
        active ? "bg-accent-subtle" : "hover:bg-subtle",
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
      <KindBadge kind={kind} />
      <span className={cn("min-w-0 truncate text-[12px]", active ? "font-medium text-accent" : "text-text")}>
        {name}
      </span>
      {current ? <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">현재</span> : null}
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
  onPick: (pick: CatalogPick) => void;
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
    onPick({
      database,
      schema,
      table: item.name,
      qualified: qualifiedName(layout, database, schema, item.name),
    });
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
