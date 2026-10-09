ALTER TABLE admins ADD COLUMN display_name text NOT NULL DEFAULT '';
ALTER TABLE admins ADD COLUMN contact text NOT NULL DEFAULT '';
ALTER TABLE admins ADD COLUMN platform_operator boolean NOT NULL DEFAULT false;
CREATE TABLE commerce_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 currency text NOT NULL DEFAULT '' CHECK(currency IN ('','CNY','USD','USDT')),
 payment_instructions text NOT NULL DEFAULT '',
 payout_channel text NOT NULL DEFAULT '',
 recharge_enabled boolean NOT NULL DEFAULT false,
 withdrawal_enabled boolean NOT NULL DEFAULT false,
 registration_enabled boolean NOT NULL DEFAULT false,
 commission_bps int NOT NULL DEFAULT 0 CHECK(commission_bps BETWEEN 0 AND 10000),
 min_recharge_cents bigint NOT NULL DEFAULT 100 CHECK(min_recharge_cents>0),
 min_withdrawal_cents bigint NOT NULL DEFAULT 100 CHECK(min_withdrawal_cents>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO commerce_settings(singleton) VALUES(true);
CREATE TABLE wallets (
 tenant_id uuid NOT NULL REFERENCES tenants,
 kind text NOT NULL CHECK(kind IN ('balance','commission')),
 available_cents bigint NOT NULL DEFAULT 0 CHECK(available_cents>=0),
 held_cents bigint NOT NULL DEFAULT 0 CHECK(held_cents>=0),
 PRIMARY KEY(tenant_id,kind)
);
CREATE TABLE wallet_entries (
 id bigserial PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants,
 kind text NOT NULL,
 event text NOT NULL,
 source_id text NOT NULL,
 available_delta bigint NOT NULL,
 held_delta bigint NOT NULL,
 available_after bigint NOT NULL CHECK(available_after>=0),
 held_after bigint NOT NULL CHECK(held_after>=0),
 note text NOT NULL DEFAULT '',
 actor_id uuid NOT NULL REFERENCES admins,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,kind) REFERENCES wallets(tenant_id,kind),
 UNIQUE(tenant_id,kind,event,source_id)
);
CREATE INDEX wallet_entries_tenant_idx ON wallet_entries(tenant_id,kind,id DESC);
CREATE TABLE referral_profiles (
 tenant_id uuid PRIMARY KEY REFERENCES tenants,
 code text NOT NULL UNIQUE,
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE referrals (
 referred_tenant_id uuid PRIMARY KEY REFERENCES tenants,
 referrer_tenant_id uuid NOT NULL REFERENCES tenants,
 code text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(referred_tenant_id<>referrer_tenant_id)
);
CREATE INDEX referrals_owner_idx ON referrals(referrer_tenant_id,created_at DESC);
CREATE TABLE recharge_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants,
 request_id uuid NOT NULL,
 currency text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','credited','rejected','cancelled','refunded')),
 payment_reference text NOT NULL,
 receipt_reference text UNIQUE,
 refund_reference text UNIQUE,
 note text NOT NULL DEFAULT '',
 review_note text NOT NULL DEFAULT '',
 reviewed_by uuid REFERENCES admins,
 created_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 UNIQUE(tenant_id,request_id)
);
CREATE INDEX recharge_tenant_idx ON recharge_orders(tenant_id,created_at DESC);
CREATE TABLE commissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL UNIQUE REFERENCES recharge_orders,
 tenant_id uuid NOT NULL REFERENCES tenants,
 referred_tenant_id uuid NOT NULL REFERENCES tenants,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 rate_bps int NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
 status text NOT NULL DEFAULT 'credited' CHECK(status IN ('credited','reversed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE commission_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants,
 request_id uuid NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_id)
);
CREATE TABLE withdrawal_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants,
 request_id uuid NOT NULL,
 currency text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 channel text NOT NULL,
 destination_cipher text NOT NULL,
 destination_masked text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected','cancelled')),
 payout_reference text UNIQUE,
 review_note text NOT NULL DEFAULT '',
 reviewed_by uuid REFERENCES admins,
 created_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 UNIQUE(tenant_id,request_id)
);
CREATE INDEX withdrawal_tenant_idx ON withdrawal_requests(tenant_id,created_at DESC);
CREATE TABLE usage_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants,
 account_id uuid NOT NULL REFERENCES platform_accounts,
 request_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider='google-free'),
 input_chars int NOT NULL CHECK(input_chars BETWEEN 1 AND 4000),
 output_chars int NOT NULL CHECK(output_chars BETWEEN 1 AND 32000),
 target_language text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_id)
);
CREATE INDEX usage_tenant_idx ON usage_records(tenant_id,created_at DESC);
-- Purchase history has a real, empty source until a priced product is configured.
CREATE TABLE purchase_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants,
 product_name text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>=0),
 currency text NOT NULL,
 status text NOT NULL CHECK(status IN ('paid','refunded')),
 created_at timestamptz NOT NULL DEFAULT now()
);
