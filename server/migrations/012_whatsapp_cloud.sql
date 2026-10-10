-- Cloud and native Web accounts share customer identity, not browser sessions.
ALTER TABLE platform_accounts ADD COLUMN connection_type text NOT NULL DEFAULT 'web' CHECK(connection_type IN ('web','cloud'));
ALTER TABLE platform_accounts ALTER COLUMN code_id DROP NOT NULL;
ALTER TABLE platform_accounts ALTER COLUMN proxy_id DROP NOT NULL;
ALTER TABLE platform_accounts ADD CONSTRAINT account_connection_check CHECK (
 (connection_type='web' AND code_id IS NOT NULL AND proxy_id IS NOT NULL) OR
 (connection_type='cloud' AND platform='whatsapp' AND code_id IS NULL AND proxy_id IS NULL AND device_id IS NULL)
);
CREATE TABLE wa_cloud_apps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 meta_app_id text NOT NULL UNIQUE, secret_cipher text NOT NULL,
 verify_cipher text NOT NULL, verify_hash text NOT NULL,
 verified_at timestamptz, last_event_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
CREATE TABLE wa_cloud_numbers (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants, app_id uuid NOT NULL,
 phone_id text NOT NULL UNIQUE, waba_id text NOT NULL, token_cipher text NOT NULL,
 display_phone text NOT NULL, verified_name text NOT NULL DEFAULT '', quality text NOT NULL DEFAULT 'UNKNOWN',
 enabled boolean NOT NULL DEFAULT true, auth_status text NOT NULL DEFAULT 'valid',
 last_error text NOT NULL DEFAULT '', checked_at timestamptz NOT NULL DEFAULT now(), subscribed_at timestamptz,
 templates jsonb NOT NULL DEFAULT '[]', templates_at timestamptz,
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES platform_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,app_id) REFERENCES wa_cloud_apps(tenant_id,id)
);
CREATE UNIQUE INDEX login_codes_tenant_id_idx ON login_codes(tenant_id,id);
CREATE TABLE wa_cloud_assignments (
 tenant_id uuid NOT NULL, number_id uuid NOT NULL, code_id uuid NOT NULL,
 PRIMARY KEY(number_id,code_id), FOREIGN KEY(tenant_id,number_id) REFERENCES wa_cloud_numbers(tenant_id,id),
 FOREIGN KEY(tenant_id,code_id) REFERENCES login_codes(tenant_id,id)
);
CREATE INDEX wa_cloud_assignments_code ON wa_cloud_assignments(tenant_id,code_id);
CREATE TABLE wa_cloud_chats (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, number_id uuid NOT NULL,
 customer_id text NOT NULL, name text NOT NULL DEFAULT '', last_inbound_at timestamptz,
 last_message_at timestamptz NOT NULL DEFAULT now(), unread int NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,number_id,customer_id), UNIQUE(tenant_id,number_id,id),
 FOREIGN KEY(tenant_id,number_id) REFERENCES wa_cloud_numbers(tenant_id,id)
);
CREATE TABLE wa_cloud_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigserial UNIQUE,
 tenant_id uuid NOT NULL, number_id uuid NOT NULL, chat_id uuid NOT NULL,
 direction text NOT NULL CHECK(direction IN ('in','out')), kind text NOT NULL,
 body text NOT NULL DEFAULT '', payload jsonb NOT NULL DEFAULT '{}',
 meta_id text, request_id uuid, fingerprint text NOT NULL DEFAULT '',
 source_code_id uuid REFERENCES login_codes, actor text NOT NULL DEFAULT '',
 status text NOT NULL, error text NOT NULL DEFAULT '', attempts int NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), sending_at timestamptz,
 occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,number_id,meta_id), UNIQUE(tenant_id,number_id,request_id),
 FOREIGN KEY(tenant_id,number_id,chat_id) REFERENCES wa_cloud_chats(tenant_id,number_id,id)
);
CREATE INDEX wa_cloud_messages_chat ON wa_cloud_messages(tenant_id,number_id,chat_id,seq DESC);
CREATE INDEX wa_cloud_outbox ON wa_cloud_messages(next_attempt_at) WHERE status='queued';
CREATE TABLE wa_cloud_receipts (
 tenant_id uuid NOT NULL, number_id uuid NOT NULL, meta_id text NOT NULL, status text NOT NULL,
 recipient text NOT NULL, request_id text NOT NULL DEFAULT '', error text NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL,
 PRIMARY KEY(number_id,meta_id,status), FOREIGN KEY(tenant_id,number_id) REFERENCES wa_cloud_numbers(tenant_id,id)
);
CREATE TABLE wa_cloud_media (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, number_id uuid NOT NULL,
 meta_id text NOT NULL, mime text NOT NULL, filename text NOT NULL DEFAULT '', size bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,number_id,meta_id),
 FOREIGN KEY(tenant_id,number_id) REFERENCES wa_cloud_numbers(tenant_id,id)
);
