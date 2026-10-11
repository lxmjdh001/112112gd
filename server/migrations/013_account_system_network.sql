-- Native accounts may use the current computer's network without a managed proxy.
-- Existing proxy bindings and Cloud API account constraints stay intact.
ALTER TABLE platform_accounts DROP CONSTRAINT account_connection_check;
ALTER TABLE platform_accounts ADD CONSTRAINT account_connection_check CHECK (
 (connection_type='web' AND code_id IS NOT NULL) OR
 (connection_type='cloud' AND platform='whatsapp' AND code_id IS NULL AND proxy_id IS NULL AND device_id IS NULL)
);
