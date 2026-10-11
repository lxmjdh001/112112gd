-- Money is stored in hundredths: 100 cents = CNY 1 = one account-day point.
-- Automatic debits have no human administrator actor.
ALTER TABLE wallet_entries ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE platform_accounts ADD COLUMN billing_identity text NOT NULL DEFAULT '';
ALTER TABLE client_sessions ADD COLUMN revoked_reason text NOT NULL DEFAULT '';
CREATE TABLE account_billing_state (
 tenant_id uuid PRIMARY KEY REFERENCES tenants,
 grace_days_used integer NOT NULL DEFAULT 0 CHECK(grace_days_used BETWEEN 0 AND 3),
 covered_day date,
 blocked_at timestamptz
);
CREATE TABLE account_grace_days (
 tenant_id uuid NOT NULL REFERENCES tenants,
 billing_day date NOT NULL,
 PRIMARY KEY(tenant_id,billing_day)
);
CREATE TABLE account_billing_days (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants,
 platform text NOT NULL,
 identity text NOT NULL,
 billing_day date NOT NULL,
 account_id uuid NOT NULL REFERENCES platform_accounts,
 account_label text NOT NULL,
 status text NOT NULL CHECK(status IN ('paid','grace')),
 points integer NOT NULL CHECK(points IN (0,1)),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,platform,identity,billing_day),
 CHECK((status='paid' AND points=1) OR (status='grace' AND points=0))
);
CREATE INDEX account_billing_days_tenant ON account_billing_days(tenant_id,billing_day DESC,created_at DESC);
UPDATE commerce_settings SET currency='CNY' WHERE currency='';
UPDATE commerce_settings SET registration_enabled=true;
