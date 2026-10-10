package app

import (
	"context"
	"slices"

	"github.com/jackc/pgx/v5"
)

// An IP may have multiple records, ports and credentials. Lock the shared scope
// before any proxy row locks; code authorization locks, when needed, come first.
func lockProxyHosts(ctx context.Context, tx pgx.Tx, tenant string, hosts []string) error {
	ordered := slices.Clone(hosts)
	slices.Sort(ordered)
	for _, host := range slices.Compact(ordered) {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 7007011))`, tenant+"/"+host); err != nil {
			return err
		}
	}
	return nil
}
