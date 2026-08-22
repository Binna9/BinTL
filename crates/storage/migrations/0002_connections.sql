CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    driver TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    database_name TEXT NOT NULL,
    username TEXT NOT NULL,
    password_cipher TEXT NOT NULL,
    ssl INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
