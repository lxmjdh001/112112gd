package app

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestSameProxyIPSharesPerPlatformLimit(t *testing.T) {
	h := setup(t)
	ctx := context.Background()
	h.commerceCall(t, "POST", "/proxies/import", h.admin, gin.H{"lines": "192.0.2.1:1080\nhttp://user:pass@192.0.2.1:1081"})
	_, list := h.call("GET", "/proxies", h.admin, nil)
	proxies := list["data"].([]any)
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i, item := range proxies {
		_, raw := h.code(t)
		_, auth := h.login(raw, fmt.Sprint("ip-device-", i))
		client := auth["data"].(map[string]any)["accessToken"].(string)
		wg.Add(1)
		go func(i int, proxy any, client string) {
			defer wg.Done()
			s, _ := h.call("POST", "/client/accounts", client, gin.H{"label": "shared IP", "platform": "whatsapp", "proxyId": proxy, "requestId": key(900 + i)})
			statuses <- s
		}(i, item.(map[string]any)["id"], client)
	}
	wg.Wait()
	close(statuses)
	created, rejected := 0, 0
	for s := range statuses {
		if s == 200 {
			created++
		} else if s == 409 {
			rejected++
		} else {
			t.Fatal("unexpected create response", s)
		}
	}
	if created != 1 || rejected != 1 {
		t.Fatal("same IP bypassed limit via a second record", created, rejected)
	}
	first := proxies[0].(map[string]any)["id"].(string)
	// A future platform has an independent counter on the same fixed IP.
	if _, err := h.app.DB.Exec(ctx, `INSERT INTO platform_accounts(tenant_id,code_id,proxy_id,platform,label) SELECT tenant_id,code_id,proxy_id,'line','future LINE' FROM platform_accounts LIMIT 1`); err != nil {
		t.Fatal(err)
	}
	_, list = h.call("GET", "/proxies", h.admin, nil)
	for _, row := range list["data"].([]any) {
		usage := row.(map[string]any)["platformUsage"].(map[string]any)
		if usage["whatsapp"] != float64(1) || usage["line"] != float64(1) {
			t.Fatal("incorrect shared IP counters", usage)
		}
	}
	h.commerceCall(t, "PATCH", "/proxies/"+first, h.admin, gin.H{"maxAccountsPerPlatform": 2})
	// Re-importing that IP with an inflated limit cannot create another allowance.
	h.commerceCall(t, "POST", "/proxies/import", h.admin, gin.H{"lines": "192.0.2.1:1082", "maxAccountsPerPlatform": 100})
	_, list = h.call("GET", "/proxies", h.admin, nil)
	if len(list["data"].([]any)) != 3 {
		t.Fatal("missing duplicate-IP fixture")
	}
	for _, row := range list["data"].([]any) {
		if row.(map[string]any)["maxAccountsPerPlatform"] != float64(2) {
			t.Fatal("same IP settings diverged", row)
		}
	}
	_, raw := h.code(t)
	_, auth := h.login(raw, "another")
	client := auth["data"].(map[string]any)["accessToken"].(string)
	h.commerceCall(t, "POST", "/client/accounts", client, gin.H{"label": "second WA", "platform": "whatsapp", "proxyId": first, "requestId": key(950)})
	if s, _ := h.call("PATCH", "/proxies/"+first, h.admin, gin.H{"maxAccountsPerPlatform": 1}); s != 409 {
		t.Fatal("lowered below shared IP usage", s)
	}
}
