ALTER TABLE sessions ADD COLUMN device_hash text;

CREATE TABLE employee_pairing_invites (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL UNIQUE,
  server_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE employee_device_bindings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL,
  token_hash text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employee_pairing_audit (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('invited','bound','signed_out','unbound')),
  happened_at timestamptz NOT NULL DEFAULT now()
);
