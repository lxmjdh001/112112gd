CREATE TABLE customer_profiles (
 tenant_id uuid NOT NULL REFERENCES tenants,
 platform text NOT NULL,
 identifier text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 language text NOT NULL DEFAULT 'en',
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,platform,identifier)
);
CREATE TABLE customer_tags (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 30),
 UNIQUE(tenant_id,name), UNIQUE(tenant_id,id)
);
CREATE TABLE customer_tag_links (
 tenant_id uuid NOT NULL,
 platform text NOT NULL,
 identifier text NOT NULL,
 tag_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,platform,identifier,tag_id),
 FOREIGN KEY(tenant_id,tag_id) REFERENCES customer_tags(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE quick_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants,
 owner_code_id uuid REFERENCES login_codes,
 kind text NOT NULL CHECK(kind IN ('text','image')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
 category text NOT NULL DEFAULT '默认',
 body text NOT NULL DEFAULT '',
 mime text NOT NULL DEFAULT '',
 filename text NOT NULL DEFAULT '',
 data_cipher text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quick_assets_tenant_owner_idx ON quick_assets(tenant_id,owner_code_id,kind);
