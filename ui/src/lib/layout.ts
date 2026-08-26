export const layout = {
  split: {
    nav: 240,
    minNav: 148,
    maxNav: 320,
    connections: 176,
    sidebar: 272,
    catalog: 256,
    inspect: 420,
    columns: 240,
    editor: 256,
    builder: 192,
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
} as const;
