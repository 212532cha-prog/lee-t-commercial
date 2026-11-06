ALTER TABLE system_settings ADD COLUMN restore_marker uuid;
CREATE TABLE backup_config (
 id integer PRIMARY KEY CHECK (id=1),
 path1 text,
 path2 text,
 last_auto_day date,
 warning jsonb,
 upload_limit bigint NOT NULL DEFAULT 8589934592 CHECK (upload_limit BETWEEN 1048576 AND 1099511627776)
);
INSERT INTO backup_config(id) VALUES(1);
CREATE TABLE backup_runs (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('automatic','manual','pre_cleanup','pre_restore')),
 snapshot_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 path text NOT NULL,
 bytes bigint NOT NULL,
 sha256 text NOT NULL,
 verified boolean NOT NULL DEFAULT false,
 missing boolean NOT NULL DEFAULT false
);
CREATE TABLE backup_uploads (
 id uuid PRIMARY KEY,
 bytes bigint NOT NULL,
 sha256 text NOT NULL,
 snapshot_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
