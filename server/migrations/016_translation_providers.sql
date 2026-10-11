ALTER TABLE usage_records DROP CONSTRAINT usage_records_provider_check;
ALTER TABLE usage_records ADD CONSTRAINT usage_records_provider_check CHECK (provider IN ('google-free','mymemory'));
