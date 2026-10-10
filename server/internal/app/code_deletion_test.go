package app

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestDeleteCodesRevokesAuthorizationAndPreservesHistory(t *testing.T) {
	h := setup(t)
	ctx := context.Background()
	client, tenant, accounts := baselineFixtures(t, h)
	var first string
	if err := h.app.DB.QueryRow(ctx, `SELECT code_id::text FROM platform_accounts WHERE id=$1`, accounts[0]).Scan(&first); err != nil {
		t.Fatal(err)
	}
	raw := h.commerceCall(t, "POST", "/login-codes/"+first+"/copy", h.admin, nil)["code"].(string)
	second, _ := h.code(t)
	keep, keepRaw := h.code(t)
	group := h.group(t, "待删除组")
	h.commerceCall(t, "POST", "/login-codes/move-group", h.admin, gin.H{"ids": []string{first, second}, "groupId": group})
	h.commerceCall(t, "POST", "/baselines/import", h.admin, gin.H{"platform": "whatsapp", "text": "447410419512", "accountId": accounts[0], "requestId": key(801)})
	h.commerceCall(t, "POST", "/client/conversations", client, gin.H{"accountId": accounts[0], "identifier": "447410419512"})
	var foreignTenant, foreignCode string
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO tenants(name) VALUES('foreign') RETURNING id::text`).Scan(&foreignTenant); err != nil {
		t.Fatal(err)
	}
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO login_codes(tenant_id,label,code_hash,suffix,expires_at) VALUES($1,'foreign','foreign-code-hash','suffix',now()+interval '1 day') RETURNING id::text`, foreignTenant).Scan(&foreignCode); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]string{{}, {first, first}, make([]string, 501)} {
		if s, _ := h.call("POST", "/login-codes/batch-delete", h.admin, gin.H{"ids": invalid}); s != 400 {
			t.Fatal("invalid selection accepted", s)
		}
	}
	for _, missing := range []string{foreignCode, "missing"} {
		if s, _ := h.call("POST", "/login-codes/batch-delete", h.admin, gin.H{"ids": []string{first, missing}}); s != 404 {
			t.Fatal("invalid batch must fail atomically", s)
		}
	}
	if s, _ := h.call("DELETE", "/login-codes/"+foreignCode, h.admin, nil); s != 404 {
		t.Fatal("cross-tenant deletion accepted", s)
	}
	if s, _ := h.call("POST", "/login-codes/batch-delete", client, gin.H{"ids": []string{first}}); s != 401 {
		t.Fatal("client may not delete codes", s)
	}
	if s, _ := h.call("POST", "/client/heartbeat", client, nil); s != 200 {
		t.Fatal("failed batch changed authorization", s)
	}
	for range 2 {
		result := h.commerceCall(t, "POST", "/login-codes/batch-delete", h.admin, gin.H{"ids": []string{first, second}})
		if result["count"] != float64(2) {
			t.Fatal("batch/retry count", result)
		}
	}
	if s, _ := h.call("POST", "/client/heartbeat", client, nil); s != 401 {
		t.Fatal("deleted code session still works", s)
	}
	if s, _ := h.login(raw, "new-device"); s != 401 {
		t.Fatal("deleted code still logs in", s)
	}
	for _, route := range []string{"reset", "copy"} {
		if s, _ := h.call("POST", "/login-codes/"+first+"/"+route, h.admin, nil); s != 404 {
			t.Fatal("deleted code still accessible", route, s)
		}
	}
	if s, _ := h.call("POST", "/login-codes/"+first+"/recover", h.admin, gin.H{"code": raw}); s != 400 {
		t.Fatal("deleted code can be recovered", s)
	}
	if s, _ := h.call("PATCH", "/login-codes/"+first, h.admin, gin.H{"label": "restore", "enabled": true, "expiresAt": time.Now().Add(time.Hour)}); s != 404 {
		t.Fatal("deleted code can be re-enabled", s)
	}
	if s, _ := h.call("POST", "/login-codes/move-group", h.admin, gin.H{"ids": []string{first}, "groupId": group}); s != 404 {
		t.Fatal("deleted code still movable", s)
	}
	_, list := h.call("GET", "/login-codes", h.admin, nil)
	rows := list["data"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["id"] != keep {
		t.Fatal("deleted/foreign code leaked in list", list)
	}
	_, list = h.call("GET", "/login-code-groups", h.admin, nil)
	if list["data"].([]any)[0].(map[string]any)["codeCount"] != float64(0) {
		t.Fatal("deleted codes counted in group", list)
	}
	_, list = h.call("GET", "/devices", h.admin, nil)
	if len(list["data"].([]any)) != 0 {
		t.Fatal("deleted code devices still visible")
	}
	var preserved bool
	if err := h.app.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM platform_accounts WHERE code_id=$1)=4 AND (SELECT count(*) FROM baseline_entries WHERE tenant_id=$2)=1 AND (SELECT count(*) FROM customer_conversations WHERE tenant_id=$2)=1 AND NOT EXISTS(SELECT 1 FROM client_sessions s JOIN devices d ON d.id=s.device_id WHERE d.code_id=$1) AND EXISTS(SELECT 1 FROM login_codes WHERE id=$1 AND deleted_at IS NOT NULL AND NOT enabled AND code_cipher='')`, first, tenant).Scan(&preserved); err != nil || !preserved {
		t.Fatal("authorization cleanup or history preservation failed", err)
	}
	_, list = h.call("GET", "/platform-accounts", h.admin, nil)
	for _, row := range list["data"].([]any) {
		if row.(map[string]any)["status"] != "code_deleted" {
			t.Fatal("retained account must show deletion state", row)
		}
	}
	if s, _ := h.login(keepRaw, "unaffected"); s != 200 {
		t.Fatal("unselected code affected", s)
	}
	if s, _ := h.call("DELETE", "/login-codes/"+keep, h.admin, nil); s != 200 {
		t.Fatal("single deletion failed", s)
	}
}

func TestDeleteCodeConcurrentLogin(t *testing.T) {
	h := setup(t)
	code, raw := h.code(t)
	var wg sync.WaitGroup
	wg.Add(2)
	var loginStatus, deleteStatus int
	go func() { defer wg.Done(); loginStatus, _ = h.login(raw, "racing-device") }()
	go func() { defer wg.Done(); deleteStatus, _ = h.call("DELETE", "/login-codes/"+code, h.admin, nil) }()
	wg.Wait()
	if deleteStatus != 200 || (loginStatus != 200 && loginStatus != 401) {
		t.Fatal("unexpected concurrent result", deleteStatus, loginStatus)
	}
	var sessions int
	if err := h.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM client_sessions s JOIN devices d ON d.id=s.device_id WHERE d.code_id=$1`, code).Scan(&sessions); err != nil || sessions != 0 {
		t.Fatal("concurrent login survived deletion", err, sessions)
	}
}

func TestLoginCodeHasNoAccountQuota(t *testing.T) {
	h := setup(t)
	_, raw := h.code(t)
	status, result := h.login(raw, "creator")
	if status != 200 {
		t.Fatal(status)
	}
	client := result["data"].(map[string]any)["accessToken"].(string)
	h.commerceCall(t, "POST", "/proxies/import", h.admin, gin.H{"lines": "first:1080\nsecond:1080\nthird:1080\nfourth:1080"})
	_, result = h.call("GET", "/proxies", h.admin, nil)
	for i, row := range result["data"].([]any) {
		request := gin.H{"label": "account", "platform": "whatsapp", "proxyId": row.(map[string]any)["id"], "requestId": fmt.Sprintf("00000000-0000-4000-8000-%012d", i)}
		h.commerceCall(t, "POST", "/client/accounts", client, request)
		request["requestId"] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+100)
		if s, _ := h.call("POST", "/client/accounts", client, request); s != 409 {
			t.Fatal("proxy limit bypassed", s)
		}
	}
	options := h.commerceCall(t, "GET", "/client/account-options", client, nil)
	if options["usedAccounts"] != float64(4) || options["maxAccounts"] != nil {
		t.Fatal("code account quota remains", options)
	}
}
