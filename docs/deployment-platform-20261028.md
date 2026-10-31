# Platform management production deployment - 2026-10-28

Release: `/opt/d1scrm/releases/platform-management-20261028T023442Z`.
Previous: `/opt/d1scrm/releases/client-ui-0.1.12-20261028T014220Z` (retained).
Base revision: `7faf66bff62ffa0b47ac93bdf885ca62831ca9af`, with authorized working-tree changes. Source digest `71b2bcbbe5b763c788393ed9085034cd77cda4a051bf12346f6907e50e974e8a`; complete source archive and artifact checksums included in the release.

Scope: administrator-only platform management menu; customer user listing/details/web-access enable/disable/password reset; existing recharge records and approval, withdrawal approval, and settings centralized under this menu. Administrator accounts are protected. Regular customers retain existing business menus. Backend operator middleware guards every management endpoint.

Migration 022 adds nullable `admins.disabled_at`. Existing accounts remain enabled. Account credentials, tenant data, login codes, client/device sessions, platform accounts, wallets and ledger rows remain intact. Before/after business snapshots and hashes matched, including account data (excluding the new nullable column), wallet data, financial entries and client session counts. No customer or administrator was added, removed, disabled or reset during deployment verification.

Pre-release backup: `/var/backups/d1scrm/20261028T023434Z.tar.gz`, SHA-256 `a0e884330902dd47ff00a72318ccefd13da1d56f9926be057d13476e45c61d19`.
Post-release backup: `/var/backups/d1scrm/20261028T023619Z.tar.gz`.
Protected copies retained under `~/.local/share/gongdan007/production/backups/20261028/`.

Environment and Caddy configuration hashes unchanged. CSP inline hash matched. Previous hashed static resources retained. Download inventory unchanged; desktop 0.1.12 Windows and both Mac installers remain available. API, Caddy and backup timer active; T1 remains paused.

Validation before release: admin build/typecheck; isolated PostgreSQL operator permissions, user state changes, password/session revocation and migration tests; admin navigation, financial workflows and dedicated platform management E2E tests. Customer menu/direct-route isolation and HTTP 403 management denial verified in isolated local tests.

Production validation: administrator 7cadmin logs into both domains with the operator role; five management pages and read-only management/business APIs; anonymous management requests rejected with HTTP 401; protected administrator actions absent; responsive layout and no JavaScript/CSP errors. Validation web sessions are logged out. No production financial or user mutations performed.

Public homepage/download checks executed from the server using ordinary HTTPS validation. Local browser regression used the same HTTPS names pinned to the origin to avoid the previously observed local DNS routing issue. Packaged desktop 0.1.12 started with an isolated profile and the production API correctly rejected an invalid login code; existing profile sentinel retained.

Rollback: previous application and static resources remain available. The additive column is compatible with the former API, but the former API does not enforce disabled_at. After any customer has been disabled, confirm access-policy handling before application rollback. Do not restore an old database just to revert application code, because subsequent business activity must be retained.
