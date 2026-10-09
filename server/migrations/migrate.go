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
	}{{1, initial}, {2, loginCodeGroups}, {3, clientAccountCreation}, {4, proxyControls}, {5, accountPromotion}, {6, baseline}, {7, codePlatforms}} {
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
