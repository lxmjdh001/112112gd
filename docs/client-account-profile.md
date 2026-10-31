# Account portraits and presence - development change

The account sidebar displays Online / Offline / Error (Chinese UI labels). A web slot is online only after the existing platform observer reports ready and the main process validates the signed-in owner identity. QR/login/loading/closed/paused slots are offline; network/storage/unconfirmed-state/permission errors are errors. Slots bound to another device are offline. Cloud numbers use API channel availability, not a person's messaging presence. Detailed reasons remain in account tooltips and accessible names.

Self portraits are observed within authenticated account partitions. WhatsApp uses explicit own-profile controls and the account-list header, excluding conversation headers/dialogs. Telegram matches avatar elements marked with the authenticated owner's peer ID. LINE reads only the authenticated Redux profile picture URL. Missing/changed selectors or inaccessible images do not alter login state; initials remain when no usable snapshot is available. No arbitrary chat avatar is used as a fallback.

Images are rasterized to a 64x64 PNG inside the platform preload. Fetches retain the platform session and obey CORS, use an allowlist of platform image origins, a timeout and a bounded response size. The main process verifies the sender/main frame, current owner and a bounded PNG header/size before accepting it. The shell accepts raster data only. Profile snapshots are stored with the existing encrypted local authorization cache; no avatar is uploaded to the service. Verified logout/owner changes clear stale portraits; network errors retain the known self portrait.

Validation: desktop build/typecheck, 48 unit tests and synthetic Electron UI regression. A green self-avatar and red selected-contact avatar confirm the account reads its own photo; wrong-owner/shell-frame/SVG submissions are rejected. Network errors retain the portrait and display Error. Existing grouping, collapse/native view bounds, lifecycle, dialogs and keyboard tests pass.

Real authenticated WhatsApp/Telegram/LINE pages have not been visually verified for this change. Platform DOM changes or CORS restrictions can leave initials in place; use real-account validation before public packaging. This is a local source change; public client installers remain version 0.1.12 and have not been republished for this change.

## Admin account list synchronization

Admin and client now share `packages/platform/core/presence.ts` for the three status categories and reason text. Admin rows use success/info/danger tags and a keyboard-focusable reason tooltip. Presentation contains no implementation-oriented status labels. Original observation codes, server freshness rules, account authorization, billing and data storage remain unchanged.

The list refreshes every 15 seconds while visible, refreshes again on return, retains filters and stops its timer on unmount. A ready observation older than 90 seconds is displayed offline even when the most recent refresh fails. API connection states do not use native-account heartbeat expiry. Sync failures retain the last known records and show a retry hint.

Verified admin stale/QR/API/error mapping, tooltip wording, automatic updates without losing search input and 1440/1024/390 layouts; client regression and all 49 unit tests passed. This synchronization remains a local source/build change until separately published.
