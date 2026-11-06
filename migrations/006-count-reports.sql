CREATE SEQUENCE count_task_code_sequence;
CREATE SEQUENCE count_report_code_sequence;
ALTER TABLE count_tasks ADD COLUMN task_code text NOT NULL UNIQUE DEFAULT ('T'||lpad(nextval('count_task_code_sequence')::text,6,'0'));
ALTER TABLE count_tasks ADD COLUMN published_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE count_tasks ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE count_tasks ADD COLUMN accepted_at timestamptz;
ALTER TABLE count_tasks ADD COLUMN execution_started_at timestamptz;
ALTER TABLE count_tasks ADD COLUMN run_token_hash text;
ALTER TABLE count_tasks ADD COLUMN execution_session_hash text;
ALTER TABLE count_tasks ADD COLUMN heartbeat_at timestamptz;
ALTER TABLE count_tasks ADD COLUMN channel_open boolean NOT NULL DEFAULT false;
CREATE TABLE count_reports (
 id uuid PRIMARY KEY,
 report_code text NOT NULL UNIQUE DEFAULT ('R'||lpad(nextval('count_report_code_sequence')::text,6,'0')),
 task_id uuid UNIQUE REFERENCES count_tasks(id) ON DELETE SET NULL,
 task_code text NOT NULL,
 task_title text NOT NULL,
 submitted_by uuid NOT NULL REFERENCES users(id),
 employee_name text NOT NULL,
 accepted_at timestamptz NOT NULL,
 started_at timestamptz NOT NULL,
 submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_id uuid NOT NULL UNIQUE,
 trashed boolean NOT NULL DEFAULT false
);
CREATE INDEX count_report_order ON count_reports(submitted_at DESC,id DESC);
CREATE TABLE count_report_items (
 report_id uuid NOT NULL REFERENCES count_reports(id) ON DELETE CASCADE,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 product_name text NOT NULL,
 product_code text NOT NULL,
 system_quantity bigint NOT NULL,
 actual_quantity bigint NOT NULL CHECK (actual_quantity >= 0),
 difference bigint NOT NULL,
 PRIMARY KEY(report_id,product_id)
);
