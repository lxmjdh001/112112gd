# Platform management

Administrator-only sidebar group `/platform`, authorized by the server-provided `operator` role. Regular customer roles retain the existing business menus. Every management API also uses the existing operator middleware, so hiding a menu is not the only access control.

Pages:
- `/platform/users`: paginated account search, role/status filters, account/contact/team details, shared team points and account counts, last login, enable/disable web access, reset customer passwords (8-16 characters).
- `/platform/records`: read-only cross-team recharge history.
- `/platform/recharges`: existing recharge approval/rejection/refund actions.
- `/platform/withdrawals`: existing withdrawal approval/payment/rejection actions.
- `/platform/settings`: existing registration, recharge, payout, commission and settlement settings.

The old account-center operations tab now links to the centralized group; customer account-center features remain unchanged. Financial flows reuse CommerceOperations and FinanceTable; no changes to accounting, approvals or refund rules.

User access changes:
- Platform administrator records are protected from disable/reset through this screen. Administrators change their own passwords in Account Center.
- Disabling a customer prevents new web logins and revokes that customer's current web sessions. Re-enabling allows the original password again.
- Password reset revokes that customer's web sessions. It does not enable a disabled user.
- Team data, point balances, financial history and client login-code/device sessions remain intact. There is no physical user-deletion action.
- Mutations are transactional, lock the target row and emit audit records without passwords.

Migration 022 adds nullable `admins.disabled_at`. Existing rows remain enabled; no business rows are removed or overwritten. Validated locally, then deployed to production on 2026-10-28 at the user's request. See deployment-platform-20261028.md for release, backup and verification records.

UI continues the existing client/admin blue-gray tokens, Chinese system fonts, Element Plus controls and shared business page styles. Empty/error states, sensitive-action confirmations, password clearing and responsive tables are included.

Validation: admin build/typecheck; isolated PostgreSQL permission/status/password tests and migration tests; original admin and financial E2E regression; dedicated platform-management UI regression; local preview across five pages at 1440/1024/390 widths. Test schemas are isolated and dropped by the harness.
