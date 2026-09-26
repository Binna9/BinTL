export type LoadSchemaAlign = {
  matched: string[];
  extra: string[];
  missing: string[];
  novel: boolean;
};

export function validLoadTable(name: string) {
  const parts = name.trim().split(".");
  return parts.length >= 1 && parts.length <= 2 && parts.every((part) => /^[A-Za-z0-9_]+$/.test(part));
}

export function alignLoadSchema(input: string[], dest: string[]): LoadSchemaAlign {
  const destByKey = new Map(dest.map((name) => [name.toLocaleLowerCase(), name]));
  const inputByKey = new Map(input.map((name) => [name.toLocaleLowerCase(), name]));
  const matched: string[] = [];
  const extra: string[] = [];
  for (const name of input) {
    if (destByKey.has(name.toLocaleLowerCase())) matched.push(name);
    else extra.push(name);
  }
  const missing = dest.filter((name) => !inputByKey.has(name.toLocaleLowerCase()));
  return { matched, extra, missing, novel: dest.length === 0 };
}

if (import.meta.env.DEV) {
  const aligned = alignLoadSchema(["id", "Name"], ["ID", "email"]);
  if (aligned.matched.join() !== "id" || aligned.extra.join() !== "Name" || aligned.missing.join() !== "email") {
    throw new Error("load schema: name match must ignore case");
  }
  if (!alignLoadSchema(["a"], []).novel || !validLoadTable("sales.fact") || validLoadTable("a.b.c")) {
    throw new Error("load schema: new table and ident rules");
  }
}
