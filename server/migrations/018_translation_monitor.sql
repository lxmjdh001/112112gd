CREATE TABLE translation_provider_checks (
 tenant_id uuid NOT NULL REFERENCES tenants,
 provider text NOT NULL CHECK(provider IN ('google-free','mymemory','libretranslate')),
 status text NOT NULL CHECK(status IN ('checking','available','limited','quota','timeout','unavailable')),
 started_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz,
 latency_ms bigint NOT NULL DEFAULT 0 CHECK(latency_ms >= 0),
 PRIMARY KEY (tenant_id,provider)
);
CREATE INDEX usage_provider_tenant_time_idx ON usage_records(tenant_id,provider,created_at DESC);
