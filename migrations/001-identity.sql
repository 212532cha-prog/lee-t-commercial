CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (length(username) BETWEEN 1 AND 64 AND username = btrim(username)),
  real_name text NOT NULL CHECK (length(real_name) BETWEEN 1 AND 128),
  role text NOT NULL CHECK (role IN ('admin','employee')),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  session_generation bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_administrator ON users(role) WHERE role = 'admin';
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  csrf_token text NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE system_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  maintenance boolean NOT NULL DEFAULT false,
  admin_backup_required boolean NOT NULL DEFAULT false
);
INSERT INTO system_settings(id) VALUES(1);
-- Only task ownership/state is reserved here; counting/publication is stage 6.
CREATE TABLE count_tasks (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','active','completed','cancelled')),
  assigned_user_id uuid REFERENCES users(id),
  run_generation bigint NOT NULL DEFAULT 0,
  CHECK ((status = 'active' AND assigned_user_id IS NOT NULL) OR status <> 'active')
);
CREATE UNIQUE INDEX one_active_task_per_employee ON count_tasks(assigned_user_id) WHERE status = 'active';
