package app

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	"gongdan007/server/internal/security"
)

func TestClientProxyCreationAndRetry(t *testing.T) {
	h := setup(t)
	code, raw := h.code(t)
	_, login := h.login(raw, "proxy-creator")
	token := login["data"].(map[string]any)["accessToken"].(string)
	body := gin.H{"label": "客户端 IP", "protocol": "socks5", "host": " EXAMPLE.COM. ", "port": 1080, "username": "user@name", "password": "secret:with/@ #", "tenantId": "forged", "maxAccountsPerPlatform": 9999, "enabled": false}
	if s, _ := h.call("POST", "/client/proxies", h.admin, body); s != 401 {
		t.Fatal("admin token accepted", s)
	}
	id := h.commerceCall(t, "POST", "/client/proxies", token, body)["id"].(string)
	var tenantOK, enabled bool
	var host, cipher string
	var max int
	err := h.app.DB.QueryRow(context.Background(), `SELECT p.tenant_id=l.tenant_id,p.enabled,p.host,p.password_cipher,p.max_accounts_per_platform FROM proxies p JOIN login_codes l ON l.id=$2 WHERE p.id=$1`, id, code).Scan(&tenantOK, &enabled, &host, &cipher, &max)
	if err != nil || !tenantOK || !enabled || host != "example.com" || max != 1 {
		t.Fatal("invalid ownership/defaults", err, host, max)
	}
	secret, err := security.Open(h.app.Key, cipher)
	if err != nil || secret != body["password"] || cipher == secret {
		t.Fatal("credentials not encrypted correctly", err)
	}
	for range 2 {
		if retry := h.commerceCall(t, "POST", "/client/proxies", token, body); retry["id"] != id {
			t.Fatal("duplicate proxy on retry")
		}
	}
	_, listed := h.call("GET", "/proxies", h.admin, nil)
	if len(listed["data"].([]any)) != 1 || strings.Contains(fmt.Sprint(listed), body["password"].(string)) || strings.Contains(fmt.Sprint(listed), cipher) {
		t.Fatal("admin synchronization or credential exposure")
	}
	options := h.commerceCall(t, "GET", "/client/account-options", token, nil)
	if len(options["proxies"].([]any)) != 1 || strings.Contains(fmt.Sprint(options), "password") || strings.Contains(fmt.Sprint(options), "user@name") {
		t.Fatal("client options leaked credentials")
	}
	account := h.commerceCall(t, "POST", "/client/accounts", token, gin.H{"label": "test", "platform": "whatsapp", "proxyId": id, "requestId": key(2100)})["id"].(string)
	opened := h.commerceCall(t, "POST", "/client/accounts/"+account+"/open", token, gin.H{})
	if opened["proxy"].(map[string]any)["password"] != body["password"] {
		t.Fatal("proxy credentials not available to bound account")
	}
	// Existing IP limits are shared even with different ports and credentials.
	body["port"] = 1081
	body["password"] = "different"
	second := h.commerceCall(t, "POST", "/client/proxies", token, body)["id"].(string)
	if s, _ := h.call("POST", "/client/accounts", token, gin.H{"label": "over limit", "platform": "whatsapp", "proxyId": second, "requestId": key(2101)}); s != 409 {
		t.Fatal("client-created proxy bypassed IP limit", s)
	}
	h.commerceCall(t, "PATCH", "/proxies/"+id, h.admin, gin.H{"maxAccountsPerPlatform": 3})
	body["port"] = 1082
	third := h.commerceCall(t, "POST", "/client/proxies", token, body)["id"].(string)
	if err = h.app.DB.QueryRow(context.Background(), `SELECT max_accounts_per_platform FROM proxies WHERE id=$1`, third).Scan(&max); err != nil || max != 3 {
		t.Fatal("existing limit not inherited", err, max)
	}
	h.commerceCall(t, "POST", "/proxies/batch", h.admin, gin.H{"ids": []string{id, second, third}, "enabled": false})
	if s, _ := h.call("POST", "/client/proxies", token, body); s != 409 {
		t.Fatal("disabled proxy re-enabled by retry", s)
	}
	body["port"] = 1083
	if s, _ := h.call("POST", "/client/proxies", token, body); s != 409 {
		t.Fatal("disabled IP bypassed with another port", s)
	}
}

func TestClientProxyValidationAndTenantScope(t *testing.T) {
	h := setup(t)
	code, raw := h.code(t)
	_, login := h.login(raw, "proxy-validation")
	token := login["data"].(map[string]any)["accessToken"].(string)
	valid := gin.H{"label": "", "protocol": "http", "host": "[2001:db8::1]", "port": 8080, "username": "", "password": ""}
	for _, invalid := range []gin.H{{"protocol": "ftp"}, {"host": ""}, {"host": "http://example.com"}, {"host": "a b"}, {"port": 0}, {"port": 65536}, {"port": 1.5}, {"username": "only-user"}, {"password": "only-pass"}, {"label": strings.Repeat("名", 101)}} {
		body := gin.H{}
		for k, v := range valid {
			body[k] = v
		}
		for k, v := range invalid {
			body[k] = v
		}
		if s, _ := h.call("POST", "/client/proxies", token, body); s != 400 {
			t.Fatal("invalid input accepted", invalid, s)
		}
	}
	var foreignTenant, foreignProxy string
	if err := h.app.DB.QueryRow(context.Background(), `INSERT INTO tenants(name) VALUES('foreign') RETURNING id::text`).Scan(&foreignTenant); err != nil {
		t.Fatal(err)
	}
	cipher, _ := security.Seal(h.app.Key, "")
	if err := h.app.DB.QueryRow(context.Background(), `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher) VALUES($1,'foreign','http','2001:db8::1',8080,'',$2) RETURNING id::text`, foreignTenant, cipher).Scan(&foreignProxy); err != nil {
		t.Fatal(err)
	}
	valid["tenantId"] = foreignTenant
	id := h.commerceCall(t, "POST", "/client/proxies", token, valid)["id"].(string)
	if id == foreignProxy {
		t.Fatal("reused another team's proxy")
	}
	var host, label string
	if err := h.app.DB.QueryRow(context.Background(), `SELECT host,label FROM proxies WHERE id=$1`, id).Scan(&host, &label); err != nil || host != "2001:db8::1" || label != host {
		t.Fatal("IPv6/default label invalid", err)
	}
	if _, err := h.app.DB.Exec(context.Background(), `UPDATE login_codes SET allowed_platforms='{}' WHERE id=$1`, code); err != nil {
		t.Fatal(err)
	}
	if s, _ := h.call("POST", "/client/proxies", token, valid); s != 403 {
		t.Fatal("unassigned platform created proxy", s)
	}
	if _, err := h.app.DB.Exec(context.Background(), `UPDATE login_codes SET enabled=false WHERE id=$1`, code); err != nil {
		t.Fatal(err)
	}
	if s, _ := h.call("POST", "/client/proxies", token, valid); s != 401 {
		t.Fatal("disabled code created proxy", s)
	}
}

func TestConcurrentClientProxyDeduplication(t *testing.T) {
	h := setup(t)
	_, raw := h.code(t)
	_, login := h.login(raw, "proxy-concurrent")
	token := login["data"].(map[string]any)["accessToken"].(string)
	_, otherRaw := h.code(t)
	_, otherLogin := h.login(otherRaw, "other-proxy-concurrent")
	other := otherLogin["data"].(map[string]any)["accessToken"].(string)
	var wg sync.WaitGroup
	results := make(chan string, 8)
	for n := range 8 {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			client := token
			if n%2 == 0 {
				client = other
			}
			s, data := h.call("POST", "/client/proxies", client, gin.H{"protocol": "http", "host": "192.0.2.7", "port": 8080})
			if s != 200 {
				results <- fmt.Sprint("error ", s)
				return
			}
			results <- data["data"].(map[string]any)["id"].(string)
		}(n)
	}
	wg.Wait()
	close(results)
	ids := map[string]bool{}
	for id := range results {
		if strings.HasPrefix(id, "error") {
			t.Fatal(id)
		}
		ids[id] = true
	}
	if len(ids) != 1 {
		t.Fatal("concurrent duplicate proxies", len(ids))
	}
	var count int
	if err := h.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM proxies`).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate rows", err, count)
	}
}
