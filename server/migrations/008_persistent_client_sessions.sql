-- Preserve currently valid client sessions without reviving expired or revoked credentials.
-- Login-code expiry, enablement and device activity remain enforced by API authentication.
UPDATE client_sessions s SET expires_at = 'infinity'
FROM devices d JOIN login_codes l ON l.id = d.code_id
WHERE s.device_id = d.id AND s.expires_at > now()
  AND d.active AND l.enabled AND l.expires_at > now();
