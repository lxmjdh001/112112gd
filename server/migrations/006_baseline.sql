CREATE UNIQUE INDEX accounts_tenant_id_idx ON platform_accounts(tenant_id,id);
CREATE TABLE baseline_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 request_id uuid NOT NULL, fingerprint text NOT NULL, platform text NOT NULL,
 account_id uuid, source text NOT NULL,
 total int NOT NULL, added int NOT NULL, skipped int NOT NULL, invalid int NOT NULL,
 errors jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_id), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id)
);
CREATE TABLE baseline_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 platform text NOT NULL CHECK(platform IN ('whatsapp','line')), identifier text NOT NULL DEFAULT '',
 customer_ip text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
 account_id uuid, batch_id uuid,
 enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(identifier<>'' OR customer_ip<>''), UNIQUE(tenant_id,platform,identifier,customer_ip),
 FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES baseline_batches(tenant_id,id)
);
CREATE INDEX baseline_identity_idx ON baseline_entries(tenant_id,platform,identifier) WHERE enabled AND identifier<>'';
CREATE INDEX baseline_ip_idx ON baseline_entries(tenant_id,platform,customer_ip) WHERE enabled AND customer_ip<>'';
CREATE TABLE customer_conversations (
 seq bigserial UNIQUE,
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 account_id uuid NOT NULL, platform text NOT NULL,
 identifier text NOT NULL, customer_ip text NOT NULL DEFAULT '',
 duplicate_account boolean NOT NULL, duplicate_ip boolean NOT NULL,
 baseline_match boolean NOT NULL, history_match boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,account_id,identifier),
 FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id)
);
CREATE INDEX conversations_identity_idx ON customer_conversations(tenant_id,platform,identifier,seq);
CREATE INDEX conversations_ip_idx ON customer_conversations(tenant_id,platform,customer_ip,seq) WHERE customer_ip<>'';
CREATE INDEX baseline_list_idx ON baseline_entries(tenant_id,created_at DESC);
CREATE INDEX baseline_batches_idx ON baseline_batches(tenant_id,created_at DESC);
CREATE INDEX conversations_list_idx ON customer_conversations(tenant_id,created_at DESC);
