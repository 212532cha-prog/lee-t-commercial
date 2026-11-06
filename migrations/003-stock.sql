ALTER TABLE inventory_events ADD COLUMN revision bigint NOT NULL DEFAULT 0;
CREATE INDEX inventory_event_sequence ON inventory_events(product_id,id);
CREATE TABLE inventory_checkpoints (
 product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 through_id bigint NOT NULL DEFAULT 0,
 quantity bigint NOT NULL DEFAULT 0
);
INSERT INTO inventory_checkpoints(product_id) SELECT id FROM products;
CREATE TABLE stock_requests (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE stock_request_items (
 request_id uuid NOT NULL REFERENCES stock_requests(id) ON DELETE CASCADE,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 quantity bigint NOT NULL,
 after_quantity bigint NOT NULL,
 version bigint NOT NULL,
 PRIMARY KEY(request_id,product_id)
);
CREATE SEQUENCE stock_draft_revision_sequence;
CREATE TABLE stock_drafts (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('inbound','outbound')),
 revision bigint NOT NULL DEFAULT nextval('stock_draft_revision_sequence'),
 saved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE stock_draft_items (
 user_id uuid NOT NULL REFERENCES stock_drafts(user_id) ON DELETE CASCADE,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 quantity bigint NOT NULL CHECK (quantity > 0),
 PRIMARY KEY(user_id,product_id)
);
CREATE TABLE negative_notifications (
 product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 read_at timestamptz
);
