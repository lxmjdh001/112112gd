-- Preserve all existing accounts; NULL means web login remains enabled.
ALTER TABLE admins ADD COLUMN disabled_at timestamptz;
