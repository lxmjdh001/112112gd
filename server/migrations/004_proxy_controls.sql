CREATE TABLE proxy_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name),
    UNIQUE (tenant_id, id)
);
ALTER TABLE proxies ADD COLUMN group_id uuid;
INSERT INTO proxy_groups(tenant_id,name)
    SELECT DISTINCT tenant_id,btrim(group_name) FROM proxies WHERE btrim(group_name)<>'';
UPDATE proxies p SET group_id=g.id FROM proxy_groups g
    WHERE p.tenant_id=g.tenant_id AND btrim(p.group_name)=g.name;
ALTER TABLE proxies ADD CONSTRAINT proxies_group_fk
    FOREIGN KEY (tenant_id,group_id) REFERENCES proxy_groups(tenant_id,id)
    ON DELETE SET NULL (group_id);
ALTER TABLE proxies ADD COLUMN max_accounts_per_platform int NOT NULL DEFAULT 1
    CHECK (max_accounts_per_platform >= 1);
-- Existing associations stay valid; a fresh proxy defaults to one account per platform.
UPDATE proxies p SET max_accounts_per_platform=GREATEST(1,(
    SELECT max(used) FROM (SELECT count(*)::int AS used FROM platform_accounts a
    WHERE a.proxy_id=p.id GROUP BY a.platform) usage
));
CREATE INDEX proxies_group_idx ON proxies(tenant_id,group_id);
CREATE INDEX accounts_proxy_platform_idx ON platform_accounts(proxy_id,platform);
