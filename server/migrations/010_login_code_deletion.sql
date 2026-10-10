-- Numeric account limits belong to proxies, not login codes.
ALTER TABLE login_codes DROP COLUMN max_devices, DROP COLUMN max_accounts;

-- Keep account/customer history and its foreign keys when deleting an authorization.
ALTER TABLE login_codes ADD COLUMN deleted_at timestamptz;
ALTER TABLE login_codes ADD CONSTRAINT deleted_code_disabled CHECK (deleted_at IS NULL OR NOT enabled);
