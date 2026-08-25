import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { MSSQL, MySQL, PostgreSQL, SQLite, StandardSQL, sql } from "@codemirror/lang-sql";
import { indentWithTab } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { useTheme } from "@/hooks/useTheme";
import type { DatabaseColumn } from "@/types/connection";

export type SqlEditorHandle = {
  insertAtCursor: (text: string) => void;
  focus: () => void;
};

type SqlEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  driver?: string;
  table?: string | null;
  columns?: DatabaseColumn[];
  onRun?: () => void;
  onClear?: () => void;
};

function sqlDialect(driver?: string) {
  switch (driver) {
    case "mysql":
    case "mariadb":
      return MySQL;
    case "mssql":
      return MSSQL;
    case "sqlite":
      return SQLite;
    case "postgres":
    case "redshift":
    case "cockroach":
      return PostgreSQL;
    default:
      return StandardSQL;
  }
}

function editorTheme(dark: boolean) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "transparent",
        fontSize: "13px",
        color: "var(--theme-text)",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "inherit",
        lineHeight: "1.5",
      },
      ".cm-content": {
        padding: "12px 12px 24px",
        caretColor: "var(--theme-accent)",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "var(--theme-text-tertiary)",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--theme-accent) 7%, transparent)",
      },
      ".cm-activeLineGutter": { backgroundColor: "transparent" },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--theme-accent) 28%, transparent) !important",
      },
      ".cm-cursor": { borderLeftColor: "var(--theme-accent)" },
      ".cm-placeholder": { color: "var(--theme-text-tertiary)" },
      ".cm-tooltip": {
        backgroundColor: "var(--theme-surface)",
        border: "1px solid var(--theme-border)",
        color: "var(--theme-text)",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--theme-accent-subtle)",
        color: "var(--theme-text)",
      },
    },
    { dark },
  );
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { value, onChange, placeholder, disabled, driver, table, columns, onRun, onClear },
  ref,
) {
  const { theme } = useTheme();
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const onRunRef = useRef(onRun);
  const onClearRef = useRef(onClear);
  const onChangeRef = useRef(onChange);
  const driverRef = useRef(driver);
  onRunRef.current = onRun;
  onClearRef.current = onClear;
  onChangeRef.current = onChange;
  driverRef.current = driver;

  useImperativeHandle(ref, () => ({
    insertAtCursor(text: string) {
      const view = cmRef.current?.view;
      if (!view) {
        onChangeRef.current(value + text);
        return;
      }
      const from = view.state.selection.main.from;
      const to = view.state.selection.main.to;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    },
    focus() {
      cmRef.current?.view?.focus();
    },
  }));

  const extensions = useMemo(() => {
    const schema: Record<string, string[]> = {};
    const names = (columns ?? []).map((column) => column.name);
    if (table && names.length) {
      schema[table] = names;
      const short = table.includes(".") ? table.slice(table.lastIndexOf(".") + 1) : table;
      schema[short] = names;
    }
    return [
      sql({
        dialect: sqlDialect(driver),
        schema: Object.keys(schema).length ? schema : undefined,
        upperCaseKeywords: true,
      }),
      EditorView.lineWrapping,
      cmPlaceholder(placeholder),
      editorTheme(theme === "dark"),
      Prec.high(
        keymap.of([
          indentWithTab,
          {
            key: "Mod-Enter",
            run: () => {
              onRunRef.current?.();
              return true;
            },
          },
          {
            key: "Mod-Backspace",
            run: () => {
              onClearRef.current?.();
              return true;
            },
          },
        ]),
      ),
    ];
  }, [columns, driver, placeholder, table, theme]);

  return (
    <CodeMirror
      ref={cmRef}
      className="sql-editor h-full min-h-0"
      value={value}
      height="100%"
      theme="none"
      editable={!disabled}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: true,
        autocompletion: true,
        bracketMatching: true,
        indentOnInput: true,
        tabSize: 2,
        searchKeymap: true,
        closeBrackets: true,
      }}
      extensions={extensions}
      onChange={onChange}
    />
  );
});
