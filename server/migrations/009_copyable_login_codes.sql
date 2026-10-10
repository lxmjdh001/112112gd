-- The existing hash remains the authentication key. Legacy codes cannot be reconstructed.
ALTER TABLE login_codes ADD COLUMN code_cipher text NOT NULL DEFAULT '';
