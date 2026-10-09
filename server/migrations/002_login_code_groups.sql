CREATE TABLE login_code_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants,
    name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 50),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name),
    UNIQUE (tenant_id, id)
);

ALTER TABLE login_codes ADD COLUMN group_id uuid;
-- Preserve the code and its tenant when a group is removed.
ALTER TABLE login_codes ADD CONSTRAINT login_codes_group_fk
    FOREIGN KEY (tenant_id, group_id) REFERENCES login_code_groups (tenant_id, id)
    ON DELETE SET NULL (group_id);
CREATE INDEX login_codes_group_idx ON login_codes (tenant_id, group_id);
