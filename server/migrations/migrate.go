package migrations

import (
	"context"
	_ "embed"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed 001_initial.sql
var initial string

//go:embed 002_login_code_groups.sql
var loginCodeGroups string

//go:embed 003_client_account_creation.sql
var clientAccountCreation string

//go:embed 004_proxy_controls.sql
var proxyControls string

//go:embed 005_account_promotion.sql
var accountPromotion string

//go:embed 006_baseline.sql
var baseline string

//go:embed 007_code_platforms.sql
var codePlatforms string

//go:embed 008_persistent_client_sessions.sql
var persistentClientSessions string

//go:embed 009_copyable_login_codes.sql
var copyableLoginCodes string

//go:embed 010_login_code_deletion.sql
var loginCodeDeletion string

//go:embed 011_shared_proxy_ip_limits.sql
var sharedProxyIPLimits string

//go:embed 012_whatsapp_cloud.sql
var whatsappCloud string

//go:embed 013_account_system_network.sql
var accountSystemNetwork string

//go:embed 014_customer_tools.sql
var customerTools string

//go:embed 015_account_lifecycle.sql
var accountLifecycle string

//go:embed 016_translation_providers.sql
var translationProviders string

//go:embed 017_libretranslate_provider.sql
var libreTranslateProvider string

//go:embed 018_translation_monitor.sql
var translationMonitor string

//go:embed 019_account_day_billing.sql
var accountDayBilling string

//go:embed 020_account_fingerprints.sql
var accountFingerprints string

//go:embed 021_work_orders.sql
var workOrders string

//go:embed 022_admin_access.sql
var adminAccess string

//go:embed 023_team_supervision.sql
var teamSupervision string

func Run(ctx context.Context, db *pgxpool.Pool) error {
	tx, e := db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7007001)`); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); e != nil {
		return e
	}
	for _, migration := range []struct {
		version int
		sql     string
	}{{1, initial}, {2, loginCodeGroups}, {3, clientAccountCreation}, {4, proxyControls}, {5, accountPromotion}, {6, baseline}, {7, codePlatforms}, {8, persistentClientSessions}, {9, copyableLoginCodes}, {10, loginCodeDeletion}, {11, sharedProxyIPLimits}, {12, whatsappCloud}, {13, accountSystemNetwork}, {14, customerTools}, {15, accountLifecycle}, {16, translationProviders}, {17, libreTranslateProvider}, {18, translationMonitor}, {19, accountDayBilling}, {20, accountFingerprints}, {21, workOrders}, {22, adminAccess}, {23, teamSupervision}} {
		var applied bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, migration.version).Scan(&applied); e != nil {
			return e
		}
		if applied {
			continue
		}
		if _, e = tx.Exec(ctx, migration.sql); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES($1)`, migration.version); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
