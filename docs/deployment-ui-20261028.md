# Production UI and password policy deployment - 2026-10-28

Release: `/opt/d1scrm/releases/ui-password-20261028T013242Z` on 187.77.129.250.
Previous: `/opt/d1scrm/releases/28f04338ad70-linux-amd64` (retained).

Built from base revision `7faf66bff62ffa0b47ac93bdf885ca62831ca9af` plus the authorized working-tree changes. The release contains a source archive, source digest, manifest, and artifact SHA-256 list. No client installer was replaced.

Scope: public homepage and admin UI share the desktop palette, typography, controls and focus styles. Registration and new account passwords accept 8-16 characters; existing passwords continue to authenticate. No schema changes; migration remains 21.

Pre-release backup: `/var/backups/d1scrm/20261028T013212Z.tar.gz`, SHA-256 `c2a664bd3a86a3913120b0f303c4e6508d4793d8ce2ea35f21cc8e94d221d1da`.
Post-release backup: `/var/backups/d1scrm/20261028T013507Z.tar.gz`.
Both copied to protected local storage under `~/.local/share/gongdan007/production/backups/20261028/`.

Existing tenants (3), login codes (4), platform accounts (16), and conversations (0) retained. At the user's additional request, created platform administrator `7cadmin` in the existing administrator tenant; admins increased from 3 to 4. Existing admins and their credentials remain unchanged. No passwords are included here.

Environment file hash unchanged. CSP inline script hash unchanged. Caddy configuration unchanged. Download file path/size inventory unchanged. Previous hashed static assets retained. API, Caddy and backup timer active; T1 remains inactive.

Validation: admin build/typecheck; PostgreSQL registration/change-password boundaries at 7,8,16,17 characters; both public domains with six viewport widths; conversation demo, calculator, mobile navigation, installation disclosure, canonical, API health, invalid registration password rejection, and all four download links (206 attachment responses). Real login as the new administrator and dashboard, login codes, proxies, account center and work orders verified on both domains. No JavaScript or CSP errors. Read-only authenticated business APIs checked; validation sessions logged out.

Rollback: point `/opt/d1scrm/current` atomically back to the previous release and restart `d1-api`. This release has no schema migration. Do not restore the database merely to reverse presentation changes, as that would discard subsequent business data.
