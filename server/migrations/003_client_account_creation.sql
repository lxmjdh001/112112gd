ALTER TABLE platform_accounts ADD COLUMN client_request_id uuid;
ALTER TABLE platform_accounts ADD COLUMN created_by_device_id uuid REFERENCES devices;
CREATE UNIQUE INDEX accounts_client_request_idx
    ON platform_accounts(code_id, client_request_id) WHERE client_request_id IS NOT NULL;
