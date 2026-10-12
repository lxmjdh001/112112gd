CREATE TABLE work_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 name text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz,
 reset_minutes int NOT NULL DEFAULT 0 CHECK(reset_minutes BETWEEN 0 AND 1439),
 target int NOT NULL DEFAULT 0 CHECK(target BETWEEN 0 AND 100000000),
 dedup_baseline boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true, token_hash text NOT NULL UNIQUE, token_cipher text NOT NULL,
 password_hash text NOT NULL DEFAULT '', expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), CHECK(end_at IS NULL OR end_at>=start_at)
);
CREATE TABLE work_order_accounts (
 tenant_id uuid NOT NULL, order_id uuid NOT NULL, account_id uuid NOT NULL,
 PRIMARY KEY(order_id,account_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES work_orders(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id)
);
-- Only message identity and time are needed. Chat text/media are never uploaded here.
CREATE TABLE account_inbound_events (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, event_id text NOT NULL,
 customer_id text NOT NULL, occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,event_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id)
);
CREATE INDEX account_inbound_window ON account_inbound_events(tenant_id,account_id,occurred_at,customer_id);
CREATE TABLE account_stats_sync (
 tenant_id uuid NOT NULL, account_id uuid PRIMARY KEY, last_sync_at timestamptz NOT NULL DEFAULT now(),
 collector_ready boolean NOT NULL DEFAULT false, first_sync_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id)
);
CREATE INDEX work_orders_list ON work_orders(tenant_id,created_at DESC);

-- WhatsApp may first expose a LID and resolve its phone number later.
-- Keep historical messages under a stable peer key, resolving aliases at query time.
CREATE TABLE account_customer_aliases (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, alias text NOT NULL, customer_id text NOT NULL,
 PRIMARY KEY(account_id,alias), FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id)
);
