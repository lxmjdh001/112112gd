# Desktop UI release 0.1.12 - 2026-10-28

Targets: Windows x64 EXE installer, macOS Apple Silicon DMG, macOS Intel DMG. The existing optimized client UI is now included in the public packages. API remains https://api.d1scrm.com. No main-process, preload, API contract or billing behavior changed for this release.

Upgrade compatibility: application ID com.d1scrm.desktop, product name D1 Scrm, Windows executable D1Scrm and default profile path @gongdan/desktop are unchanged. NSIS continues to preserve app data on uninstall. Existing installations should upgrade over the old application; account data is not bundled into installers or deleted by this release. Historic downloads remain available. No automatic updater is present.

The public homepage login and register actions now both use inline flex centering and a minimum height of 44 pixels. Geometry assertions confirm their centers and heights match. Existing mobile navigation remains functional.

Administrator cleanup was explicitly requested by the user: only 7cadmin remains. Removed the other three administrators and their web sessions, retaining all tenants, wallets, monetary entries, login codes, devices and platform accounts. Three historical wallet-entry actor references were set to NULL to satisfy foreign keys without deleting entries; original identities remain recoverable from the protected backup and the cleanup audit record. No existing business tenant was deleted.

Backup before cleanup: /var/backups/d1scrm/20261028T013845Z.tar.gz, SHA-256 0731114354b00664b94ca4db514652f648318161a388b2484685a76b4cc2a114. A protected local copy is retained under ~/.local/share/gongdan007/production/backups/20261028/.

Validation: 45 desktop unit tests; desktop typecheck; synthetic Electron UI regression covering platform grouping, native view geometry, lifecycle, dialogs, keyboard focus, reduced motion and login errors. Both Mac DMGs and ad-hoc code signatures verified. Apple Silicon and Intel apps launched using isolated profiles; the production API rejected an invalid login code correctly. Local network DNS routing was pinned to the existing origin only for this runtime check. Three platform app.asar files match byte-for-byte, with shared UI tokens, production service address and the existing profile path. Windows installer structure and archive integrity checked; Windows execution still requires a Windows machine.

Temporary official-download bridge used to work around local GitHub TLS failures. Downloads used official upstream release assets with the normal checksum validation. Local Rosetta compatibility runtime was installed for the NSIS compiler and Intel Mac smoke test. No server firewall, proxy or security configuration was changed.

Public website release: `/opt/d1scrm/releases/client-ui-0.1.12-20261028T014220Z`. The API binary is byte-identical to the previous release, so no API restart or schema migration is needed. Caddy, environment keys and download routing are unchanged.

All three app.asar files: SHA-256 `7b8415014ac312e0bd285f95bbba3e75bff7ebc18aafd8efc51ef6fd9dcd772e`. The ASAR extracted from the final Windows installer matches this value. Installer PE wrapper is x86 and embedded D1Scrm.exe is x64, as expected for NSIS.

Final validation: both domains serve 0.1.12 and all four download links return matching byte ranges, total lengths and attachment headers. Source-origin browser checks passed action alignment, six viewport widths, interactive demo, calculator, installation disclosure, registration limits, CSP and JavaScript checks. The retained administrator logged into both sites and read dashboard, login codes, proxies, account and work order APIs successfully; validation sessions logged out. Local public-domain browser checks encountered intermittent connection closures, so the public CDN download check was independently executed from the server, while browser regression used the same HTTPS names pinned to the origin.

Post-release backup: /var/backups/d1scrm/20261028T014952Z.tar.gz, SHA-256 5fecc1722c470498566b8494813dc14a601379c08b3b97a074e9e2bc0449495f. Protected local copy verified. API, Caddy and backup timer remain active; T1 remains paused.
