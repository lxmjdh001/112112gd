package app

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestClientAccountCreationOwnershipAndRetry(t *testing.T) {
	h := setup(t)
	ctx := context.Background()
	codeID, raw := h.code(t)
	otherCode, _ := h.code(t)
	if _, err := h.app.DB.Exec(ctx, `UPDATE login_codes SET max_devices=2 WHERE id=$1`, codeID); err != nil {
		t.Fatal(err)
	}
	status, body := h.login(raw, "creator")
	if status != 200 {
		t.Fatal(body)
	}
	client := body["data"].(map[string]any)["accessToken"].(string)
	device := body["data"].(map[string]any)["deviceId"].(string)
	if status, body = h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "socks5://name:secret@localhost:1080"}); status != 200 {
		t.Fatal(body)
	}
	_, body = h.call("GET", "/proxies", h.admin, nil)
	proxy := body["data"].([]any)[0].(map[string]any)["id"].(string)
	var foreignTenant, foreignProxy, disabledProxy string
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO tenants(name) VALUES('other') RETURNING id::text`).Scan(&foreignTenant); err != nil {
		t.Fatal(err)
	}
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher) VALUES($1,'other','socks5','other',1080,'','') RETURNING id::text`, foreignTenant).Scan(&foreignProxy); err != nil {
		t.Fatal(err)
	}
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher,enabled) SELECT tenant_id,'disabled','socks5','disabled',1080,'','',false FROM login_codes WHERE id=$1 RETURNING id::text`, codeID).Scan(&disabledProxy); err != nil {
		t.Fatal(err)
	}
	status, body = h.call("GET", "/client/account-options", client, nil)
	if status != 200 {
		t.Fatal(body)
	}
	options := body["data"].(map[string]any)
	proxies := options["proxies"].([]any)
	if len(proxies) != 1 || options["maxAccounts"] != float64(1) || options["usedAccounts"] != float64(0) {
		t.Fatal("wrong options", options)
	}
	if strings.Contains(fmt.Sprint(proxies), "secret") || strings.Contains(fmt.Sprint(proxies), "password") {
		t.Fatal("proxy credentials leaked before binding")
	}
	request := gin.H{"label": "客户端账号", "platform": "whatsapp", "requestId": "00000000-0000-4000-8000-000000000001", "proxyId": proxy, "codeId": otherCode}
	if s, _ := h.call("POST", "/platform-accounts", h.admin, request); s != 404 {
		t.Fatal("admin creation route still exists", s)
	}
	if s, _ := h.call("POST", "/client/accounts", h.admin, request); s != 401 {
		t.Fatal("admin token may not create client accounts", s)
	}
	for _, invalid := range []string{foreignProxy, disabledProxy, "missing"} {
		request["proxyId"] = invalid
		if s, _ := h.call("POST", "/client/accounts", client, request); s != 400 {
			t.Fatal("invalid proxy accepted", s)
		}
	}
	request["proxyId"] = proxy
	status, body = h.call("POST", "/client/accounts", client, request)
	if status != 200 {
		t.Fatal(body)
	}
	account := body["data"].(map[string]any)["id"].(string)
	var correct bool
	if err := h.app.DB.QueryRow(ctx, `SELECT code_id=$1 AND device_id=$2 AND created_by_device_id=$2 AND observed_status='not_opened' FROM platform_accounts WHERE id=$3`, codeID, device, account).Scan(&correct); err != nil || !correct {
		t.Fatal("forged ownership or premature login", err)
	}
	for range 2 {
		status, body = h.call("POST", "/client/accounts", client, request)
		if status != 200 || body["data"].(map[string]any)["id"] != account {
			t.Fatal("retry created duplicate or hit quota", status, body)
		}
	}
	request["label"] = "changed"
	if s, _ := h.call("POST", "/client/accounts", client, request); s != 409 {
		t.Fatal("key reused for different request")
	}
	request["label"] = "客户端账号"
	_, body = h.login(raw, "other-device")
	otherClient := body["data"].(map[string]any)["accessToken"].(string)
	if s, _ := h.call("POST", "/client/accounts", otherClient, request); s != 409 {
		t.Fatal("another device reused create key", s)
	}
	if s, _ := h.call("POST", "/client/accounts/"+account+"/open", otherClient, gin.H{}); s != 409 {
		t.Fatal("another device may not open new account")
	}
	_, body = h.call("GET", "/platform-accounts", h.admin, nil)
	rows := body["data"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["id"] != account || rows[0].(map[string]any)["deviceName"] != "test-device" {
		t.Fatal("client account not synchronized to admin", body)
	}
	if s, _ := h.call("POST", "/client/accounts/"+account+"/status", client, gin.H{"status": "qr_required"}); s != 200 {
		t.Fatal("status sync failed")
	}
	_, body = h.call("GET", "/platform-accounts", h.admin, nil)
	if body["data"].([]any)[0].(map[string]any)["status"] != "qr_required" {
		t.Fatal("QR state not reflected in admin")
	}
	_, body = h.call("GET", "/client/account-options", client, nil)
	if body["data"].(map[string]any)["usedAccounts"] != float64(1) {
		t.Fatal("retry duplicated account")
	}
}

func TestConcurrentClientAccountQuota(t *testing.T) {
	h := setup(t)
	_, raw := h.code(t)
	_, body := h.login(raw, "creator")
	client := body["data"].(map[string]any)["accessToken"].(string)
	h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "localhost:1080"})
	_, body = h.call("GET", "/proxies", h.admin, nil)
	proxy := body["data"].([]any)[0].(map[string]any)["id"].(string)
	var wg sync.WaitGroup
	statuses := make(chan int, 8)
	for i := range 8 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s, _ := h.call("POST", "/client/accounts", client, gin.H{"label": "test", "platform": "whatsapp", "proxyId": proxy, "requestId": fmt.Sprintf("00000000-0000-4000-8000-%012d", i)})
			statuses <- s
		}(i)
	}
	wg.Wait()
	close(statuses)
	created, denied := 0, 0
	for s := range statuses {
		if s == 200 {
			created++
		} else if s == 409 {
			denied++
		} else {
			t.Fatal("unexpected response", s)
		}
	}
	if created != 1 || denied != 7 {
		t.Fatal("account quota race", created, denied)
	}
}
