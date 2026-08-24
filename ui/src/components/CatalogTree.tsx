import { useConnectionCatalog } from "@/hooks/useConnectionCatalog";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { selectableClass } from "@/lib/selectable";
import type {
  CatalogEntry,
  CatalogLayout,
  CatalogSelection,
} from "@/types/connection";

function qualifiedName(layout: CatalogLayout, _database: string, schema: string | null, table: string) {
  if (layout === "database.schema.table") {
    return schema ? `${schema}.${table}` : table;
  }
  return table;
}

function KindIcon({ kind }: { kind: CatalogEntry["kind"] }) {
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
  kind: CatalogEntry["kind"];
  name: string;
  current?: boolean | null;
  onClick: () => void;
}) {
  const { messages } = useLanguage();
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
      {current ? <span className="ml-1 shrink-0 text-[10px] text-text-tertiary">{messages.catalog.current}</span> : null}
    </button>
  );
}

export function CatalogTree({
  connectionId,
  selected,
  onPick,
}: {
  connectionId: string;
  selected?: CatalogSelection | null;
  onPick: (pick: CatalogSelection | null) => void;
}) {
  const { messages } = useLanguage();
  const {
    catalogLayout,
    databases,
    openNodes,
    nodeChildren,
    catalogError,
    loadingNode,
    toggleDatabase,
    toggleSchema,
  } = useConnectionCatalog(connectionId);

  function onTable(database: string, schema: string | null, item: CatalogEntry) {
    const pick: CatalogSelection = {
      database,
      schema,
      table: item.name,
      qualified: qualifiedName(catalogLayout, database, schema, item.name),
    };
    if (selected?.qualified === pick.qualified && selected.database === pick.database) {
      onPick(null);
      return;
    }
    onPick(pick);
  }

  if (catalogError) {
    return <p className="p-3 text-xs text-danger">{catalogError}</p>;
  }
  if (databases.length === 0) {
    return <p className="p-3 text-xs text-text-tertiary">{messages.catalog.unavailable}</p>;
  }

  return (
    <div className="py-1">
      {databases.map((database) => {
        const dbKey = `db:${database.name}`;
        const dbOpen = Boolean(openNodes[dbKey]);
        const dbKids = nodeChildren[dbKey] ?? [];
        return (
          <div key={dbKey}>
            <RowButton
              depth={0}
              expandable
              open={dbOpen}
              kind="database"
              name={database.name}
              current={database.current}
              onClick={() => toggleDatabase(database)}
            />
            {loadingNode === dbKey ? (
              <p className="px-8 py-1 text-[11px] text-text-tertiary">{messages.common.loading}</p>
            ) : null}
            {dbOpen
              ? dbKids.map((child) => {
                  if (child.kind === "schema") {
                    const scKey = `sc:${database.name}.${child.name}`;
                    const scOpen = Boolean(openNodes[scKey]);
                    const tables = nodeChildren[scKey] ?? [];
                    return (
                      <div key={scKey}>
                        <RowButton
                          depth={1}
                          expandable
                          open={scOpen}
                          kind="schema"
                          name={child.name}
                          onClick={() => toggleSchema(database.name, child)}
                        />
                        {loadingNode === scKey ? (
                          <p className="px-10 py-1 text-[11px] text-text-tertiary">{messages.common.loading}</p>
                        ) : null}
                        {scOpen
                          ? tables.map((table) => {
                              const qualified = qualifiedName(
                                catalogLayout,
                                database.name,
                                child.name,
                                table.name,
                              );
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
                  const qualified = qualifiedName(
                    catalogLayout,
                    database.name,
                    null,
                    child.name,
                  );
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
