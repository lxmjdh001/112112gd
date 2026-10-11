package app

import (
	"context"
	"github.com/gin-gonic/gin"
	"testing"
	"time"
)

func TestNativePlatformsAuthorizationProxyAndDailyBilling(t *testing.T) {
	h := setup(t)
	code := h.commerceCall(t, "POST", "/login-codes", h.admin, gin.H{"label": "多平台", "expiresAt": time.Now().Add(time.Hour), "allowedPlatforms": []string{"whatsapp", "line", "telegram"}})
	_, response := h.login(code["code"].(string), "multi-platform")
	client := response["data"].(map[string]any)["accessToken"].(string)
	h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if result, err := h.app.DB.Exec(context.Background(), `UPDATE wallets SET available_cents=1000 WHERE kind='balance'`); err != nil || result.RowsAffected() != 1 {
		t.Fatal("fixture wallet missing", err)
	}

	h.commerceCall(t, "POST", "/proxies/import", h.admin, gin.H{"lines": "socks5://proxy.example.test:1080", "maxAccountsPerPlatform": 1})
	_, response = h.call("GET", "/proxies", h.admin, nil)
	proxy := response["data"].([]any)[0].(map[string]any)["id"].(string)
	options := h.commerceCall(t, "GET", "/client/account-options", client, nil)
	if len(options["platforms"].([]any)) != 3 {
		t.Fatal("native grants missing", options)
	}
	for i, p := range []struct{ platform, owner, bad string }{{"line", "uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "15550000001"}, {"telegram", "123456789", "@somebody"}} {
		body := gin.H{"label": p.platform, "platform": p.platform, "proxyId": proxy, "requestId": key(2300 + i*10)}
		account := h.commerceCall(t, "POST", "/client/accounts", client, body)["id"].(string)
		body["requestId"] = key(2301 + i*10)
		if s, _ := h.call("POST", "/client/accounts", client, body); s != 409 {
			t.Fatal("same-platform proxy limit not enforced", p.platform, s)
		}
		h.commerceCall(t, "POST", "/client/accounts/"+account+"/open", client, gin.H{})
		h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", client, gin.H{"status": "qr_required"})
		if s, _ := h.call("POST", "/client/accounts/"+account+"/status", client, gin.H{"status": "ready", "identifier": p.bad}); s != 409 {
			t.Fatal("invalid owner accepted", p.platform, s)
		}
		for range 2 {
			h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", client, gin.H{"status": "ready", "identifier": p.owner})
		}
		// The same real account in another slot on the system network is not double billed.
		body["requestId"] = key(2302 + i*10)
		body["proxyId"] = ""
		duplicate := h.commerceCall(t, "POST", "/client/accounts", client, body)["id"].(string)
		h.commerceCall(t, "POST", "/client/accounts/"+duplicate+"/open", client, gin.H{})
		h.commerceCall(t, "POST", "/client/accounts/"+duplicate+"/status", client, gin.H{"status": "ready", "identifier": p.owner})
	}
	billing := h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if billing["points"] != "8" || billing["todayAccounts"] != float64(2) {
		t.Fatal("native daily billing mismatch", billing)
	}
	h.commerceCall(t, "PATCH", "/login-codes/"+code["id"].(string), h.admin, gin.H{"label": "仅 WhatsApp", "enabled": true, "expiresAt": time.Now().Add(time.Hour), "allowedPlatforms": []string{"whatsapp"}})
	if s, _ := h.call("POST", "/client/accounts", client, gin.H{"label": "unauthorized", "platform": "telegram", "proxyId": "", "requestId": key(2400)}); s != 403 {
		t.Fatal("revoked platform accepted", s)
	}
}
