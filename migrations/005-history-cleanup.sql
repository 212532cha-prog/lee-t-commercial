CREATE TABLE inventory_cleanup_requests (
 id uuid PRIMARY KEY,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 fingerprint text NOT NULL,
 backup_id uuid NOT NULL,
 deleted_count integer NOT NULL,
 has_more boolean NOT NULL DEFAULT false,
 snapshot_at timestamptz NOT NULL
);
