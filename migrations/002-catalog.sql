CREATE TABLE categories (id uuid PRIMARY KEY, name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128));
CREATE TABLE suppliers (id uuid PRIMARY KEY, name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128));
CREATE TABLE warehouse_locations (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128),
 parent_id uuid REFERENCES warehouse_locations(id),
 builtin boolean NOT NULL DEFAULT false,
 CHECK (parent_id IS NULL OR parent_id <> id)
);
INSERT INTO warehouse_locations(id,name,builtin) VALUES('00000000-0000-4000-8000-000000000001','未分配位置',true);
CREATE SEQUENCE product_code_sequence START 1;
CREATE TABLE products (
 id uuid PRIMARY KEY,
 sort_order bigint NOT NULL UNIQUE,
 product_code text NOT NULL UNIQUE CHECK (length(product_code) BETWEEN 1 AND 64),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128),
 category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
 category_name_snapshot text NOT NULL,
 location_id uuid NOT NULL REFERENCES warehouse_locations(id),
 individual_cost numeric(14,2) NOT NULL CHECK (individual_cost >= 0),
 minimum_stock bigint NOT NULL CHECK (minimum_stock >= 0),
 photo_key text,
 qr_token text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX products_name_order ON products((lower(name) COLLATE "C"),sort_order);
CREATE INDEX products_category ON products(category_id);
CREATE INDEX products_location ON products(location_id);
CREATE TABLE product_suppliers (
 id uuid PRIMARY KEY,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
 supplier_name_snapshot text NOT NULL,
 is_default boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX product_supplier_unique ON product_suppliers(product_id,supplier_id) WHERE supplier_id IS NOT NULL;
CREATE UNIQUE INDEX product_supplier_default ON product_suppliers(product_id) WHERE is_default;
CREATE TABLE inventory_balances (
 product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 quantity bigint NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 0
);
-- Reserve the real event table for stage 3; stage 2 never writes a stock movement.
CREATE TABLE inventory_events (
 id bigserial PRIMARY KEY,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('inbound','outbound','adjustment')),
 quantity_delta bigint NOT NULL,
 before_quantity bigint NOT NULL,
 after_quantity bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 UNIQUE(request_id,product_id)
);
CREATE INDEX inventory_event_protection ON inventory_events(product_id,created_at DESC,id DESC);
CREATE TABLE count_task_items (
 task_id uuid NOT NULL REFERENCES count_tasks(id) ON DELETE CASCADE,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 PRIMARY KEY(task_id,product_id)
);
CREATE TABLE file_cleanup (
 file_key text PRIMARY KEY,
 attempts integer NOT NULL DEFAULT 0
);
