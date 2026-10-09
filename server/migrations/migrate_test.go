package migrations

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"gongdan007/server/internal/security"
)

func TestUpgradeExistingCodesAndRepeatMigration(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL for PostgreSQL integration tests")
	}
	ctx := context.Background()
	root, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	schema := "gd_migration_" + security.Hash(security.Token())[:16]
	if _, err = root.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer root.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(ctx, initial); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations(version) VALUES(1)`); err != nil {
		t.Fatal(err)
	}
	var tenant, code string
	if err = db.QueryRow(ctx, `INSERT INTO tenants(name) VALUES('existing') RETURNING id::text`).Scan(&tenant); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, `INSERT INTO login_codes(tenant_id,label,code_hash,suffix,expires_at,max_devices,max_accounts) VALUES($1,'existing','preserved-hash','suffix',now()+interval '1 day',2,3) RETURNING id::text`, tenant).Scan(&code); err != nil {
		t.Fatal(err)
	}

	var proxy, blankProxy string
	if err = db.QueryRow(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher,group_name,enabled) VALUES($1,'legacy','socks5','old-host',1080,'old-user','preserved-cipher','  美国代理  ',false) RETURNING id::text`, tenant).Scan(&proxy); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher,group_name) VALUES($1,'blank','socks5','blank-host',1080,'','','') RETURNING id::text`, tenant).Scan(&blankProxy); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err = db.Exec(ctx, `INSERT INTO platform_accounts(tenant_id,code_id,proxy_id,label) VALUES($1,$2,$3,'existing')`, tenant, code, proxy); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err = Run(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	var unchanged bool
	if err = db.QueryRow(ctx, `SELECT code_hash='preserved-hash' AND max_devices=2 AND max_accounts=3 AND group_id IS NULL FROM login_codes WHERE id=$1`, code).Scan(&unchanged); err != nil || !unchanged {
		t.Fatal("legacy code changed during upgrade", err)
	}

	var preserved bool
	if err = db.QueryRow(ctx, `SELECT p.max_accounts_per_platform=3 AND NOT p.enabled AND p.password_cipher='preserved-cipher' AND g.name='美国代理' FROM proxies p JOIN proxy_groups g ON p.group_id=g.id WHERE p.id=$1`, proxy).Scan(&preserved); err != nil || !preserved {
		t.Fatal("legacy proxy data lost", err)
	}
	if err = db.QueryRow(ctx, `SELECT max_accounts_per_platform=1 AND group_id IS NULL AND enabled FROM proxies WHERE id=$1`, blankProxy).Scan(&preserved); err != nil || !preserved {
		t.Fatal("ungrouped defaults wrong", err)
	}
	var versions int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&versions); err != nil || versions != 6 {
		t.Fatal("migration not idempotent", err, versions)
	}
}
