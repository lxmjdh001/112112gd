package app

import (
	"context"
	"github.com/gin-gonic/gin"
	"testing"
	"time"
)

func TestCodePlatformAuthorization(t *testing.T) {
	h := setup(t)
	body := gin.H{"label": "平台权限", "expiresAt": time.Now().Add(time.Hour)}
	for _, bad := range []any{nil, []string{}, []string{"facebook"}, []string{"tiktok"}, []string{"whatsapp", "whatsapp"}} {
		body["allowedPlatforms"] = bad
		if s, _ := h.call("POST", "/login-codes", h.admin, body); s != 400 {
			t.Fatalf("invalid grant accepted: %v %d", bad, s)
		}
	}
	delete(body, "allowedPlatforms")
	if s, _ := h.call("POST", "/login-codes", h.admin, body); s != 400 {
		t.Fatal("missing grants accepted")
	}
	body["allowedPlatforms"] = []string{"whatsapp"}
	created := h.commerceCall(t, "POST", "/login-codes", h.admin, body)
	code := created["id"].(string)
	_, d := h.login(created["code"].(string), "platform-test")
	client := d["data"].(map[string]any)["accessToken"].(string)
	h.commerceCall(t, "POST", "/proxies/import", h.admin, gin.H{"lines": "socks5://user:secret@example.test:1080", "maxAccountsPerPlatform": 3})
	_, d = h.call("GET", "/proxies", h.admin, nil)
	proxy := d["data"].([]any)[0].(map[string]any)["id"].(string)
	accountBody := gin.H{"label": "授权账号", "platform": "whatsapp", "proxyId": proxy, "requestId": key(950)}
	account := h.commerceCall(t, "POST", "/client/accounts", client, accountBody)["id"].(string)
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/open", client, gin.H{})
	opts := h.commerceCall(t, "GET", "/client/account-options", client, nil)
	if len(opts["platforms"].([]any)) != 1 {
		t.Fatal("authorized platform missing", opts)
	}
	body["enabled"] = true
	body["allowedPlatforms"] = []string{}
	h.commerceCall(t, "PATCH", "/login-codes/"+code, h.admin, body)
	if opts = h.commerceCall(t, "GET", "/client/account-options", client, nil); len(opts["platforms"].([]any)) != 0 {
		t.Fatal("revoked platform remains")
	}
	_, d = h.call("GET", "/client/platforms", client, nil)
	if len(d["data"].([]any)) != 0 {
		t.Fatal("catalog leaks revoked grant")
	}
	_, d = h.call("GET", "/client/accounts", client, nil)
	row := d["data"].([]any)[0].(map[string]any)
	if row["available"] != false || row["unavailableReason"] != "platform_not_allowed" {
		t.Fatal(row)
	}
	_, d = h.call("GET", "/platform-accounts", h.admin, nil)
	if d["data"].([]any)[0].(map[string]any)["status"] != "platform_not_allowed" {
		t.Fatal("admin status incorrect", d)
	}
	if s, _ := h.call("POST", "/client/accounts", client, accountBody); s != 403 {
		t.Fatal("retry bypassed permission", s)
	}
	for _, route := range []string{"/client/accounts/" + account + "/open", "/client/accounts/" + account + "/status", "/client/customers/check", "/client/conversations", "/client/usage"} {
		s, d := h.call("POST", route, client, gin.H{"accountId": account, "status": "ready", "identifier": "447410419512", "provider": "google-free", "inputChars": 4, "outputChars": 2, "targetLanguage": "en", "requestId": key(951)})
		if s != 404 {
			t.Fatalf("revoked platform accepted %s: %d %v", route, s, d)
		}
	}
	// Older edit forms may omit the field, but may never implicitly restore access.
	delete(body, "allowedPlatforms")
	h.commerceCall(t, "PATCH", "/login-codes/"+code, h.admin, body)
	_, d = h.call("GET", "/client/platforms", client, nil)
	if len(d["data"].([]any)) != 0 {
		t.Fatal("omitted edit restored grant")
	}
	reset := h.commerceCall(t, "POST", "/login-codes/"+code+"/reset", h.admin, gin.H{})
	_, d = h.login(reset["code"].(string), "platform-test")
	client = d["data"].(map[string]any)["accessToken"].(string)
	_, d = h.call("GET", "/client/platforms", client, nil)
	if len(d["data"].([]any)) != 0 {
		t.Fatal("code reset restored grant")
	}
	body["allowedPlatforms"] = []string{"facebook"}
	if s, _ := h.call("PATCH", "/login-codes/"+code, h.admin, body); s != 400 {
		t.Fatal("unimplemented platform granted")
	}
	body["allowedPlatforms"] = []string{"whatsapp"}
	h.commerceCall(t, "PATCH", "/login-codes/"+code, h.admin, body)
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/open", client, gin.H{})
	var n int
	h.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM platform_accounts WHERE code_id=$1`, code).Scan(&n)
	if n != 1 {
		t.Fatal("permission change altered account", n)
	}
	_, d = h.call("GET", "/client/accounts", client, nil)
	if d["data"].([]any)[0].(map[string]any)["available"] != true {
		t.Fatal("grant did not restore account")
	}
	// Another tenant cannot change or inspect this code's grant.
	h.commerceConfig(t)
	other := h.member(t, "platform-outsider", "")
	if s, _ := h.call("PATCH", "/login-codes/"+code, other, body); s != 404 {
		t.Fatal("cross tenant platform edit", s)
	}
}
