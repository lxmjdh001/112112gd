package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"gongdan007/server/internal/security"
	"gongdan007/server/migrations"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"
)

type harness struct {
	app   *App
	r     *gin.Engine
	admin string
}

func setup(t *testing.T) *harness {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL for PostgreSQL integration tests")
	}
	ctx := context.Background()
	root, e := pgxpool.New(ctx, url)
	if e != nil {
		t.Fatal(e)
	}
	schema := "gdtest_" + security.Hash(security.Token())[:16]
	if _, e = root.Exec(ctx, "CREATE SCHEMA "+schema); e != nil {
		t.Fatal(e)
	}
	cfg, e := pgxpool.ParseConfig(url)
	if e != nil {
		t.Fatal(e)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	db, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close(); root.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); root.Close() })
	if e = migrations.Run(ctx, db); e != nil {
		t.Fatal(e)
	}
	a := New(db, make([]byte, 32))
	if e = a.Bootstrap(ctx, "admin", "test-password-only-123"); e != nil {
		t.Fatal(e)
	}
	gin.SetMode(gin.TestMode)
	h := &harness{app: a, r: a.Routes()}
	status, data := h.call("POST", "/auth/login", "", gin.H{"username": "admin", "password": "test-password-only-123"})
	if status != 200 {
		t.Fatalf("login: %d %v", status, data)
	}
	h.admin = data["data"].(map[string]any)["accessToken"].(string)
	return h
}
func (h *harness) call(method, path, token string, body any) (int, map[string]any) {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.r.ServeHTTP(w, req)
	out := map[string]any{}
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}
func (h *harness) code(t *testing.T) (string, string) {
	t.Helper()
	status, data := h.call("POST", "/login-codes", h.admin, gin.H{"label": "test", "maxDevices": 1, "maxAccounts": 1, "expiresAt": time.Now().Add(time.Hour)})
	if status != 200 {
		t.Fatal(data)
	}
	v := data["data"].(map[string]any)
	return v["id"].(string), v["code"].(string)
}
func (h *harness) login(code, device string) (int, map[string]any) {
	return h.call("POST", "/client/auth", "", gin.H{"code": code, "deviceId": security.Hash(device), "deviceName": "test-device"})
}
func TestConcurrentDeviceQuota(t *testing.T) {
	h := setup(t)
	_, code := h.code(t)
	var wg sync.WaitGroup
	statuses := make(chan int, 8)
	for n := range 8 {
		wg.Add(1)
		go func(n int) { defer wg.Done(); s, _ := h.login(code, fmt.Sprint(n)); statuses <- s }(n)
	}
	wg.Wait()
	close(statuses)
	success, denied := 0, 0
	for s := range statuses {
		switch s {
		case 200:
			success++
		case 409:
			denied++
		default:
			t.Fatalf("unexpected status %d", s)
		}
	}
	if success != 1 || denied != 7 {
		t.Fatalf("quota race: success=%d denied=%d", success, denied)
	}
}
func TestCodeReuseResetAndTenantBoundary(t *testing.T) {
	h := setup(t)
	id, code := h.code(t)
	s, d := h.login(code, "device-1")
	if s != 200 {
		t.Fatal(d)
	}
	old := d["data"].(map[string]any)["accessToken"].(string)
	s, d = h.login(code, "device-1")
	if s != 200 {
		t.Fatal("same device should reuse slot", d)
	}
	token := d["data"].(map[string]any)["accessToken"].(string)
	if s, _ = h.call("POST", "/client/heartbeat", old, gin.H{}); s != 401 {
		t.Fatal("old device session must be replaced")
	}
	if s, _ = h.call("GET", "/login-codes", token, nil); s != 401 {
		t.Fatal("client token must not authorize admin endpoints")
	}
	if s, _ = h.call("POST", "/client/accounts/not-an-account/open", token, gin.H{}); s != 404 {
		t.Fatal("unowned account must be rejected", s)
	}
	var other string
	h.app.DB.QueryRow(context.Background(), `INSERT INTO tenants(name) VALUES('other') RETURNING id::text`).Scan(&other)
	var otherCode string
	h.app.DB.QueryRow(context.Background(), `INSERT INTO login_codes(tenant_id,label,code_hash,suffix,expires_at,max_devices,max_accounts) VALUES($1,'other',$2,'secret',now()+interval '1 day',1,1) RETURNING id::text`, other, security.Hash(security.Token())).Scan(&otherCode)
	if s, _ = h.call("POST", "/login-codes/"+otherCode+"/reset", h.admin, gin.H{}); s != 404 {
		t.Fatal("cross-tenant reset accepted")
	}
	if s, _ = h.call("POST", "/login-codes/"+id+"/reset", h.admin, gin.H{}); s != 200 {
		t.Fatal("reset failed")
	}
	if s, _ = h.call("POST", "/client/heartbeat", token, gin.H{}); s != 401 {
		t.Fatal("reset did not revoke session")
	}
	if s, _ = h.login(code, "device-1"); s != 401 {
		t.Fatal("old code still works")
	}
}
func TestImportAtomicAndAccountScope(t *testing.T) {
	h := setup(t)
	id, code := h.code(t)
	s, _ := h.call("POST", "/proxies/import", h.admin, gin.H{"protocol": "socks5", "lines": "host:1080\ninvalid"})
	if s != 400 {
		t.Fatal("bad import accepted")
	}
	_, d := h.call("GET", "/proxies", h.admin, nil)
	if len(d["data"].([]any)) != 0 {
		t.Fatal("partial import should not commit")
	}
	s, _ = h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "socks5://user:password@localhost:1080\nsocks5://user:password@localhost:1080"})
	if s != 200 {
		t.Fatal("valid import failed")
	}
	_, d = h.call("GET", "/proxies", h.admin, nil)
	list := d["data"].([]any)
	if len(list) != 1 {
		t.Fatal("duplicates not removed")
	}
	p := list[0].(map[string]any)
	if _, ok := p["password"]; ok {
		t.Fatal("password exposed in list")
	}
	s, d = h.call("POST", "/platform-accounts", h.admin, gin.H{"label": "WA", "codeId": id, "proxyId": p["id"]})
	if s != 200 {
		t.Fatal(d)
	}
	account := d["data"].(map[string]any)["id"].(string)
	if s, _ = h.call("POST", "/platform-accounts", h.admin, gin.H{"label": "overflow", "codeId": id, "proxyId": p["id"]}); s != 409 {
		t.Fatal("account quota ignored")
	}
	_, d = h.login(code, "device")
	token := d["data"].(map[string]any)["accessToken"].(string)
	s, d = h.call("POST", "/client/accounts/"+account+"/open", token, gin.H{})
	if s != 200 || d["data"].(map[string]any)["proxy"].(map[string]any)["password"] != "password" {
		t.Fatal("assigned client cannot obtain proxy")
	}
	h.app.DB.Exec(context.Background(), `UPDATE login_codes SET expires_at=now()-interval '1 second' WHERE id=$1`, id)
	if s, _ = h.call("POST", "/client/heartbeat", token, gin.H{}); s != 401 {
		t.Fatal("expired code accepted")
	}
}
