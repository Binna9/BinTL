CREATE TABLE search_recent_queries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    searched_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_search_recent_user_query
    ON search_recent_queries(user_id, query COLLATE NOCASE);

CREATE INDEX idx_search_recent_user_time
    ON search_recent_queries(user_id, searched_at DESC);
