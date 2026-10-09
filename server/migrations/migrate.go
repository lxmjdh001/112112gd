package migrations

import (
	"context"
	_ "embed"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed 001_initial.sql
var initial string

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
	var applied bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=1)`).Scan(&applied); e != nil {
		return e
	}
	if applied {
		return tx.Commit(ctx)
	}
	if _, e = tx.Exec(ctx, initial); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES(1)`); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
