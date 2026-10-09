-- Preserve existing codes and account profiles while adding explicit platform grants.
ALTER TABLE login_codes ADD COLUMN allowed_platforms text[] NOT NULL DEFAULT ARRAY['whatsapp']::text[];
ALTER TABLE login_codes ADD CONSTRAINT code_platforms_no_null CHECK(array_position(allowed_platforms,NULL) IS NULL);
