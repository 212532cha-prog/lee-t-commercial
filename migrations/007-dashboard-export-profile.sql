ALTER TABLE products ADD COLUMN details_version bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN profile_version bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN avatar_key text;
ALTER TABLE categories ADD COLUMN revision bigint NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN revision bigint NOT NULL DEFAULT 0;
ALTER TABLE warehouse_locations ADD COLUMN revision bigint NOT NULL DEFAULT 0;
ALTER TABLE backup_config ADD COLUMN revision bigint NOT NULL DEFAULT 0;
ALTER TABLE file_cleanup ADD COLUMN asset_kind text NOT NULL DEFAULT 'product' CHECK (asset_kind IN ('product','avatar','export'));
CREATE TABLE export_jobs (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 format text NOT NULL CHECK (format IN ('pdf','xlsx')),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ready','failed')),
 choices jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+INTERVAL '30 minutes',
 snapshot_at timestamptz,
 processed bigint NOT NULL DEFAULT 0,
 error text,
 sha256 text,
 bytes bigint
);
CREATE TABLE export_resources (
 job_id uuid NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 PRIMARY KEY(job_id,product_id)
);
CREATE TABLE export_history_resources (
 job_id uuid NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
 event_id bigint NOT NULL REFERENCES inventory_events(id) ON DELETE CASCADE,
 PRIMARY KEY(job_id,event_id)
);
CREATE TABLE export_report_resources (
 job_id uuid NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
 report_id uuid NOT NULL REFERENCES count_reports(id) ON DELETE CASCADE,
 PRIMARY KEY(job_id,report_id)
);
