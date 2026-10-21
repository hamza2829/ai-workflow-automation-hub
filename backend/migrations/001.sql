CREATE TABLE IF NOT EXISTS customers(id uuid PRIMARY KEY, name text NOT NULL, tier text NOT NULL);
INSERT INTO customers VALUES ('11111111-1111-4111-8111-111111111111','Synthetic Acme','standard') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS orders(id uuid PRIMARY KEY, idempotency_key text UNIQUE NOT NULL, payload jsonb NOT NULL, classification jsonb, status text NOT NULL DEFAULT 'received', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS approvals(order_id uuid PRIMARY KEY REFERENCES orders(id), resume_url text, decision text, resumed_at timestamptz);
CREATE TABLE IF NOT EXISTS invoice_drafts(order_id uuid PRIMARY KEY REFERENCES orders(id), external_id text NOT NULL);
CREATE TABLE IF NOT EXISTS events(id bigserial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
