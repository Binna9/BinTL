export const driverCatalog = [
  { value: "postgres", label: "Postgres" },
  { value: "redshift", label: "Redshift" },
  { value: "cockroach", label: "Cockroach" },
  { value: "mysql", label: "MySQL" },
  { value: "mariadb", label: "MariaDB" },
  { value: "mssql", label: "SQL Server" },
  { value: "sqlite", label: "SQLite" },
  { value: "oracle", label: "Oracle" },
  { value: "tibero", label: "Tibero" },
  { value: "http", label: "HTTP / API" },
] as const;

export function driverDefaultPort(driver: string): string {
  switch (driver) {
    case "mysql":
    case "mariadb":
      return "3306";
    case "mssql":
      return "1433";
    case "oracle":
      return "1521";
    case "tibero":
      return "8629";
    default:
      return "5432";
  }
}

export function isOracleFamily(driver: string): boolean {
  return driver === "oracle" || driver === "tibero";
}
