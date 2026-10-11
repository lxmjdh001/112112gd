-- Existing accounts retain their current-computer browser settings.
ALTER TABLE platform_accounts ADD COLUMN browser_fingerprint jsonb;
ALTER TABLE platform_accounts ADD CONSTRAINT account_fingerprint_object CHECK (
  browser_fingerprint IS NULL OR
  (connection_type='web' AND jsonb_typeof(browser_fingerprint)='object')
);
