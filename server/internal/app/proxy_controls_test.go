package app

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
)

func (h *harness) proxyRow(t *testing.T, host string) map[string]any {
	t.Helper()
	status, body := h.call("GET", "/proxies", h.admin, nil)
	if status != 200 {
		t.Fatal(status, body)
	}
	for _, item := range body["data"].([]any) {
		row := item.(map[string]any)
		if row["host"] == host {
			return row
		}
	}
	t.Fatal("proxy missing", host)
	return nil
}

func TestProxyGroupsSettingsAndTenantBoundary(t *testing.T) {
	h := setup(t)
	ctx := context.Background()
	s, b := h.call("POST", "/proxy-groups", h.admin, gin.H{"name": "  美国代理  "})
	if s != 200 {
		t.Fatal(b)
	}
	group := b["data"].(map[string]any)["id"].(string)
	if s, _ = h.call("POST", "/proxy-groups", h.admin, gin.H{"name": "美国代理"}); s != 409 {
		t.Fatal("duplicate group accepted", s)
	}
	for _, n := range []string{"", "未分组", "全部分组"} {
		if s, _ = h.call("POST", "/proxy-groups", h.admin, gin.H{"name": n}); s != 400 {
			t.Fatal("invalid group", s)
		}
	}
	if s, b = h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "alpha:1080\nbeta:1080", "groupId": group, "maxAccountsPerPlatform": 3, "enabled": false}); s != 200 {
		t.Fatal(b)
	}
	a, z := h.proxyRow(t, "alpha"), h.proxyRow(t, "beta")
	aid, zid := a["id"].(string), z["id"].(string)
	if a["groupId"] != group || a["group"] != "美国代理" || a["maxAccountsPerPlatform"] != float64(3) || a["enabled"] != false {
		t.Fatal("settings not persisted", a)
	}
	if s, _ = h.call("PATCH", "/proxy-groups/"+group, h.admin, gin.H{"name": "美国住宅"}); s != 200 {
		t.Fatal(s)
	}
	if h.proxyRow(t, "alpha")["group"] != "美国住宅" {
		t.Fatal("rename not reflected")
	}
	_, b = h.call("GET", "/proxy-groups", h.admin, nil)
	if b["data"].([]any)[0].(map[string]any)["proxyCount"] != float64(2) {
		t.Fatal("incorrect group count", b)
	}
	for _, n := range []int{0, -1, 10001} {
		if s, _ = h.call("PATCH", "/proxies/"+aid, h.admin, gin.H{"maxAccountsPerPlatform": n}); s != 400 {
			t.Fatal("invalid limit accepted", s)
		}
		if s, _ = h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "invalid:1080", "maxAccountsPerPlatform": n}); s != 400 {
			t.Fatal("invalid import limit", s)
		}
	}
	var tenant, foreignGroup, foreignProxy string
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO tenants(name) VALUES('other') RETURNING id::text`).Scan(&tenant); err != nil {
		t.Fatal(err)
	}
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO proxy_groups(tenant_id,name) VALUES($1,'hidden') RETURNING id::text`, tenant).Scan(&foreignGroup); err != nil {
		t.Fatal(err)
	}
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher) VALUES($1,'foreign','http','foreign',80,'','') RETURNING id::text`, tenant).Scan(&foreignProxy); err != nil {
		t.Fatal(err)
	}
	if s, _ = h.call("POST", "/proxies/batch", h.admin, gin.H{"ids": []string{aid, foreignProxy}, "enabled": true}); s != 404 {
		t.Fatal("foreign proxy batch accepted", s)
	}
	if h.proxyRow(t, "alpha")["enabled"] != false {
		t.Fatal("failed batch partially saved")
	}
	if s, _ = h.call("POST", "/proxies/batch", h.admin, gin.H{"ids": []string{aid, zid}, "groupId": foreignGroup}); s != 404 {
		t.Fatal("foreign group assignment", s)
	}
	if s, _ = h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "foreign-test:1080", "groupId": foreignGroup}); s != 404 {
		t.Fatal("foreign import group", s)
	}
	for _, method := range []string{"PATCH", "DELETE"} {
		if s, _ = h.call(method, "/proxy-groups/"+foreignGroup, h.admin, gin.H{"name": "attempt"}); s != 404 {
			t.Fatal("foreign group mutation", s)
		}
	}
	if s, b = h.call("POST", "/proxies/batch", h.admin, gin.H{"ids": []string{aid, zid}, "enabled": true}); s != 200 {
		t.Fatal(b)
	}
	a = h.proxyRow(t, "alpha")
	if a["enabled"] != true || a["groupId"] != group || a["maxAccountsPerPlatform"] != float64(3) {
		t.Fatal("partial enable overwrote settings", a)
	}
	if s, _ = h.call("POST", "/proxies/batch", h.admin, gin.H{"ids": []string{zid}, "groupId": ""}); s != 200 {
		t.Fatal("ungroup failed", s)
	}
	if s, _ = h.call("DELETE", "/proxy-groups/"+group, h.admin, nil); s != 200 {
		t.Fatal(s)
	}
	a = h.proxyRow(t, "alpha")
	if a["groupId"] != "" || a["group"] != "" || a["enabled"] != true {
		t.Fatal("delete must only ungroup", a)
	}
	if s, _ = h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "defaults:1080"}); s != 200 {
		t.Fatal(s)
	}
	a = h.proxyRow(t, "defaults")
	if a["maxAccountsPerPlatform"] != float64(1) || a["enabled"] != true || a["groupId"] != "" {
		t.Fatal("wrong defaults", a)
	}
	_, b = h.call("GET", "/proxy-groups", h.admin, nil)
	if len(b["data"].([]any)) != 0 {
		t.Fatal("foreign group leaked", b)
	}
}

func TestProxyPerPlatformLimitAndDisable(t *testing.T) {
	h := setup(t)
	ctx := context.Background()
	code, raw := h.code(t)
	_, b := h.login(raw, "proxy-test")
	client := b["data"].(map[string]any)["accessToken"].(string)
	if s, d := h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "socks5://user:secret@local:1080", "group": "legacy-group"}); s != 200 {
		t.Fatal(d)
	}
	p := h.proxyRow(t, "local")
	proxy := p["id"].(string)
	// A different platform uses its own quota, even on the same proxy.
	if _, err := h.app.DB.Exec(ctx, `INSERT INTO platform_accounts(tenant_id,code_id,proxy_id,platform,label) SELECT tenant_id,id,$2,'telegram','future platform' FROM login_codes WHERE id=$1`, code, proxy); err != nil {
		t.Fatal(err)
	}
	request := gin.H{"label": "WhatsApp", "platform": "whatsapp", "proxyId": proxy, "requestId": "00000000-0000-4000-8000-000000000011"}
	s, b := h.call("POST", "/client/accounts", client, request)
	if s != 200 {
		t.Fatal("other platform consumed WhatsApp quota", s, b)
	}
	account := b["data"].(map[string]any)["id"].(string)
	request["requestId"] = "00000000-0000-4000-8000-000000000012"
	if s, _ = h.call("POST", "/client/accounts", client, request); s != 409 {
		t.Fatal("unopened account must occupy proxy slot", s)
	}
	_, b = h.call("GET", "/client/account-options", client, nil)
	op := b["data"].(map[string]any)["proxies"].([]any)[0].(map[string]any)
	if op["maxAccountsPerPlatform"] != float64(1) || op["platformUsage"].(map[string]any)["whatsapp"] != float64(1) {
		t.Fatal("client quota not reported", op)
	}
	if s, _ = h.call("PATCH", "/proxies/"+proxy, h.admin, gin.H{"maxAccountsPerPlatform": 2}); s != 200 {
		t.Fatal(s)
	}
	if s, b = h.call("POST", "/client/accounts", client, request); s != 200 {
		t.Fatal(b)
	}
	if s, _ = h.call("PATCH", "/proxies/"+proxy, h.admin, gin.H{"maxAccountsPerPlatform": 1}); s != 409 {
		t.Fatal("limit below existing usage accepted", s)
	}
	if s, _ = h.call("POST", "/client/accounts/"+account+"/status", client, gin.H{"status": "ready", "identifier": "15550000001"}); s != 200 {
		t.Fatal(s)
	}
	if s, b = h.call("PATCH", "/proxies/"+proxy, h.admin, gin.H{"enabled": false}); s != 200 {
		t.Fatal(b)
	}
	_, b = h.call("GET", "/client/accounts", client, nil)
	for _, v := range b["data"].([]any) {
		row := v.(map[string]any)
		reason := "proxy_disabled"
		if row["platform"] != "whatsapp" {
			reason = "platform_not_allowed"
		}
		if row["available"] != false || row["unavailableReason"] != reason {
			t.Fatal("disabled account still available", row)
		}
	}
	_, b = h.call("GET", "/platform-accounts", h.admin, nil)
	for _, v := range b["data"].([]any) {
		reason := "proxy_disabled"
		if v.(map[string]any)["platform"] != "whatsapp" {
			reason = "platform_not_allowed"
		}
		if v.(map[string]any)["status"] != reason {
			t.Fatal("admin state incorrect", v)
		}
	}
	_, b = h.call("GET", "/client/account-options", client, nil)
	if len(b["data"].(map[string]any)["proxies"].([]any)) != 0 {
		t.Fatal("disabled proxy offered")
	}
	if s, _ = h.call("POST", "/client/accounts/"+account+"/open", client, gin.H{}); s != 404 {
		t.Fatal("disabled account opened", s)
	}
	if s, _ = h.call("POST", "/client/accounts/"+account+"/status", client, gin.H{"status": "ready", "identifier": "15550000001"}); s != 404 {
		t.Fatal("disabled account reports ready", s)
	}
	request["requestId"] = "00000000-0000-4000-8000-000000000013"
	if s, _ = h.call("POST", "/client/accounts", client, request); s != 400 {
		t.Fatal("disabled proxy used for creation", s)
	}
	if s, _ = h.call("DELETE", "/proxy-groups/"+p["groupId"].(string), h.admin, nil); s != 200 {
		t.Fatal(s)
	}
	if s, _ = h.call("PATCH", "/proxies/"+proxy, h.admin, gin.H{"enabled": true}); s != 200 {
		t.Fatal(s)
	}
	if s, b = h.call("POST", "/client/accounts/"+account+"/open", client, gin.H{}); s != 200 || b["data"].(map[string]any)["proxy"].(map[string]any)["password"] != "secret" {
		t.Fatal("reenabling lost binding or credentials", s, b)
	}
	_, b = h.call("GET", "/platform-accounts", h.admin, nil)
	for _, v := range b["data"].([]any) {
		if v.(map[string]any)["status"] == "ready" || v.(map[string]any)["status"] == "proxy_disabled" {
			t.Fatal("stale ready state returned on reenable", v)
		}
	}
	if h.proxyRow(t, "local")["platformUsage"].(map[string]any)["whatsapp"] != float64(2) {
		t.Fatal("account bindings lost")
	}
}

func TestConcurrentProxyQuotaAcrossLoginCodes(t *testing.T) {
	h := setup(t)
	if s, b := h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "shared:1080"}); s != 200 {
		t.Fatal(b)
	}
	proxy := h.proxyRow(t, "shared")["id"].(string)
	clients := []string{}
	for i := range 6 {
		_, raw := h.code(t)
		s, b := h.login(raw, fmt.Sprint(i))
		if s != 200 {
			t.Fatal(b)
		}
		clients = append(clients, b["data"].(map[string]any)["accessToken"].(string))
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	statuses := make(chan int, len(clients))
	for i, client := range clients {
		wg.Add(1)
		go func(i int, client string) {
			defer wg.Done()
			<-start
			s, _ := h.call("POST", "/client/accounts", client, gin.H{"label": "test", "platform": "whatsapp", "proxyId": proxy, "requestId": fmt.Sprintf("00000000-0000-4000-8000-%012d", i)})
			statuses <- s
		}(i, client)
	}
	close(start)
	wg.Wait()
	close(statuses)
	created := 0
	for s := range statuses {
		if s == 200 {
			created++
		} else if s != 409 {
			t.Fatal("unexpected response", s)
		}
	}
	if created != 1 {
		t.Fatal("proxy quota race across codes", created)
	}
}
