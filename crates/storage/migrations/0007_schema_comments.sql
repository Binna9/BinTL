-- SQLite는 COMMENT ON을 지원하지 않아 CREATE TABLE SQL에 코멘트를 넣고 테이블을 재구성한다.
-- 이 코멘트는 sqlite_master.sql에 보존된다.

CREATE TABLE jobs__commented (
    -- 변환·적재 작업
    id TEXT PRIMARY KEY,                 -- 작업 UUID
    status TEXT NOT NULL,                -- queued | running | succeeded | failed | canceled
    source_path TEXT NOT NULL,           -- 입력 파일 상대 경로
    output_path TEXT,                    -- 출력 파일 상대 경로
    spec_json TEXT NOT NULL,             -- 변환 스펙 JSON
    error_message TEXT,                  -- 실패 메시지
    created_at TEXT NOT NULL,            -- 생성 시각 (RFC3339)
    started_at TEXT,                     -- 실행 시작 시각
    finished_at TEXT,                    -- 종료 시각
    kind TEXT NOT NULL DEFAULT 'transform', -- 작업 종류. 현재 transform
    transform_id TEXT,                   -- 연결된 변환 ID
    dataset_id TEXT                      -- 연결된 데이터셋 ID
);
INSERT INTO jobs__commented (
    id, status, source_path, output_path, spec_json, error_message,
    created_at, started_at, finished_at, kind, transform_id, dataset_id
)
SELECT
    id, status, source_path, output_path, spec_json, error_message,
    created_at, started_at, finished_at, kind, transform_id, dataset_id
FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs__commented RENAME TO jobs;

CREATE TABLE job_logs__commented (
    -- 작업 실행 로그
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- 로그 행 ID
    job_id TEXT NOT NULL,                 -- 작업 ID
    ts TEXT NOT NULL,                     -- 기록 시각 (RFC3339)
    level TEXT NOT NULL,                  -- 로그 레벨 (info | error 등)
    message TEXT NOT NULL                 -- 로그 내용
);
INSERT INTO job_logs__commented (id, job_id, ts, level, message)
SELECT id, job_id, ts, level, message FROM job_logs;
DROP TABLE job_logs;
ALTER TABLE job_logs__commented RENAME TO job_logs;

CREATE TABLE connections__commented (
    -- 데이터베이스 커넥션
    id TEXT PRIMARY KEY,                 -- 커넥션 UUID
    name TEXT NOT NULL,                  -- 표시 이름
    driver TEXT NOT NULL,                -- postgres | mysql | mariadb | mssql | sqlite 등
    host TEXT NOT NULL,                  -- 호스트 또는 sqlite 경로 보조값
    port INTEGER NOT NULL,               -- 포트. sqlite는 0
    database_name TEXT NOT NULL,         -- 데이터베이스 이름 또는 sqlite 파일 경로
    username TEXT NOT NULL,              -- 접속 사용자
    password_cipher TEXT NOT NULL,       -- 암호화된 비밀번호
    ssl INTEGER NOT NULL DEFAULT 0,      -- SSL 사용 여부 (0/1)
    created_at TEXT NOT NULL             -- 생성 시각 (RFC3339)
);
INSERT INTO connections__commented (
    id, name, driver, host, port, database_name, username, password_cipher, ssl, created_at
)
SELECT
    id, name, driver, host, port, database_name, username, password_cipher, ssl, created_at
FROM connections;
DROP TABLE connections;
ALTER TABLE connections__commented RENAME TO connections;

CREATE TABLE extracts__commented (
    -- DB에서 파일로 추출한 작업
    id TEXT PRIMARY KEY,                 -- 추출 UUID
    connection_id TEXT NOT NULL,         -- 커넥션 ID
    table_name TEXT NOT NULL,            -- 대상 테이블 (schema.table 또는 SQL 추출 표시명)
    delimiter TEXT NOT NULL,             -- 출력 구분자. 쉼표·tab 등
    header INTEGER NOT NULL,             -- 헤더 행 포함 여부 (0/1)
    status TEXT NOT NULL,                -- queued | running | succeeded | failed
    stored_path TEXT,                    -- 저장된 파일 상대 경로
    filename TEXT,                       -- 저장 파일명
    row_count INTEGER,                   -- 추출 행 수
    error_message TEXT,                  -- 실패 메시지
    created_at TEXT NOT NULL,            -- 생성 시각 (RFC3339)
    started_at TEXT,                     -- 실행 시작 시각
    finished_at TEXT,                    -- 종료 시각
    sql_text TEXT,                       -- 실행한 SQL. 테이블 추출이면 비어 있을 수 있음
    catalog_database TEXT                -- 카탈로그에서 선택한 데이터베이스
);
INSERT INTO extracts__commented (
    id, connection_id, table_name, delimiter, header, status, stored_path, filename,
    row_count, error_message, created_at, started_at, finished_at, sql_text, catalog_database
)
SELECT
    id, connection_id, table_name, delimiter, header, status, stored_path, filename,
    row_count, error_message, created_at, started_at, finished_at, sql_text, catalog_database
FROM extracts;
DROP TABLE extracts;
ALTER TABLE extracts__commented RENAME TO extracts;

CREATE TABLE datasets__commented (
    -- 변환 입력 데이터셋
    id TEXT PRIMARY KEY,                 -- 데이터셋 UUID. 업로드는 파일 ID와 동일
    kind TEXT NOT NULL CHECK (kind IN ('upload', 'database', 'api')), -- 출처. upload | database | api
    extract_id TEXT,                     -- 원본 추출 ID. 업로드면 NULL
    filename TEXT NOT NULL,              -- 표시 파일명
    stored_path TEXT NOT NULL UNIQUE,    -- 저장된 파일 상대 경로
    size_bytes INTEGER,                  -- 파일 크기(바이트)
    delimiter TEXT,                      -- CSV 구분자
    has_header INTEGER,                  -- 헤더 존재 여부 (0/1)
    columns_json TEXT,                   -- inspect로 읽은 컬럼 목록 JSON
    row_count INTEGER,                   -- 행 수
    inspected_at TEXT,                   -- 마지막 inspect 시각
    created_at TEXT NOT NULL,            -- 생성 시각 (RFC3339)
    updated_at TEXT NOT NULL             -- 수정 시각 (RFC3339)
);
CREATE TABLE transforms__commented (
    -- 저장된 변환 정의
    id TEXT PRIMARY KEY,                 -- 변환 UUID
    name TEXT NOT NULL,                  -- 변환 이름
    dataset_id TEXT NOT NULL REFERENCES datasets__commented(id), -- 입력 데이터셋 ID
    spec_json TEXT NOT NULL,             -- 변환 스펙 JSON
    created_at TEXT NOT NULL,            -- 생성 시각 (RFC3339)
    updated_at TEXT NOT NULL             -- 수정 시각 (RFC3339)
);
INSERT INTO datasets__commented (
    id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
    columns_json, row_count, inspected_at, created_at, updated_at
)
SELECT
    id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
    columns_json, row_count, inspected_at, created_at, updated_at
FROM datasets;
INSERT INTO transforms__commented (
    id, name, dataset_id, spec_json, created_at, updated_at
)
SELECT id, name, dataset_id, spec_json, created_at, updated_at FROM transforms;
DROP TABLE transforms;
DROP TABLE datasets;
ALTER TABLE datasets__commented RENAME TO datasets;
ALTER TABLE transforms__commented RENAME TO transforms;
