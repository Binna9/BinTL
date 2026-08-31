export const layout = {
  split: {
    nav: 270,
    minNav: 200,
    maxNav: 360,
    connections: 176,
    sidebar: 272,
    catalog: 256,
    inspect: 420,
    columns: 240,
    editor: 256,
    builder: 192,
    settings: 248,
    minSettings: 168,
    maxSettings: 400,
    minPane: 160,
    minStack: 120,
    minBuilder: 140,
  },
  grid: {
    minColumnWidth: 80,
    defaultColumnWidth: 160,
    maxColumnWidth: 2400,
  },
  page: {
    workspaceHeight: "calc(100vh - 8rem)",
  },
  dashboard: {
    cols: 12,
    rowHeight: 56,
    gap: 12,
    stackAt: 900,
  },
} as const;
