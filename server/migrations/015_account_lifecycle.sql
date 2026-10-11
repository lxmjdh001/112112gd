ALTER TABLE platform_accounts ADD COLUMN paused_at timestamptz;
ALTER TABLE platform_accounts ADD COLUMN removed_at timestamptz;
CREATE TABLE client_account_preferences (
 tenant_id uuid NOT NULL,
 device_id uuid NOT NULL REFERENCES devices,
 account_id uuid NOT NULL,
 paused boolean NOT NULL DEFAULT false,
 hidden boolean NOT NULL DEFAULT false,
 PRIMARY KEY(device_id,account_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id)
);
