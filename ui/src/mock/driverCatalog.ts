export const driverCatalog = [
  { value: "postgres", label: "Postgres (Redshift / Cockroach 포함)" },
  { value: "redshift", label: "Redshift" },
  { value: "cockroach", label: "Cockroach" },
  { value: "mysql", label: "MySQL" },
  { value: "mariadb", label: "MariaDB" },
  { value: "mssql", label: "SQL Server" },
  { value: "sqlite", label: "SQLite (database에 파일 경로)" },
] as const;
