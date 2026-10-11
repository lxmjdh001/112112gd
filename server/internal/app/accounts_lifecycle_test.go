package app

import (
	"context"
	"github.com/gin-gonic/gin"
	"testing"
)

func TestNativeAccountCloseRemoveAndHistory(t *testing.T) {
	h := setup(t)
	_, raw := h.code(t)
	_, login := h.login(raw, "lifecycle-one")
	token := login["data"].(map[string]any)["accessToken"].(string)
	if s, d := h.call("POST", "/proxies/import", h.admin, gin.H{"lines": "socks5://127.0.0.8:1080", "maxAccountsPerPlatform": 1}); s != 200 {
		t.Fatal(s, d)
	}
	_, list := h.call("GET", "/proxies", h.admin, nil)
	proxy := list["data"].([]any)[0].(map[string]any)["id"].(string)
	body := gin.H{"label": "原账号", "platform": "whatsapp", "proxyId": proxy, "requestId": key(1501)}
	account := h.commerceCall(t, "POST", "/client/accounts", token, body)["id"].(string)
	route := "/client/accounts/" + account
	h.commerceCall(t, "POST", "/client/conversations", token, gin.H{"accountId": account, "identifier": "447410419512", "requestId": key(1503)})
	if s, _ := h.call("POST", route+"/remove", token, gin.H{}); s != 409 {
		t.Fatal("removal without close accepted", s)
	}
	h.call("POST", route+"/close", token, gin.H{})
	_, accounts := h.call("GET", "/client/accounts", token, nil)
	if row := accounts["data"].([]any)[0].(map[string]any); row["paused"] != true || row["available"] != true {
		t.Fatal("paused not resumable", row)
	}
	next := gin.H{"label": "新账号", "platform": "whatsapp", "proxyId": proxy, "requestId": key(1502)}
	if s, _ := h.call("POST", "/client/accounts", token, next); s != 409 {
		t.Fatal("pause released IP binding", s)
	}
	h.commerceCall(t, "POST", route+"/open", token, gin.H{})
	if s, _ := h.call("POST", route+"/remove", token, gin.H{}); s != 409 {
		t.Fatal("resumed account removable", s)
	}
	if s, d := h.call("POST", route+"/close", token, gin.H{}); s != 200 {
		t.Fatal(s, d)
	}
	_, otherLogin := h.login(raw, "lifecycle-other-device")
	other := otherLogin["data"].(map[string]any)["accessToken"].(string)
	if s, _ := h.call("POST", route+"/remove", other, gin.H{}); s != 404 {
		t.Fatal("other device removed account", s)
	}
	for range 2 {
		if s, d := h.call("POST", route+"/remove", token, gin.H{}); s != 200 {
			t.Fatal("idempotent removal", s, d)
		}
	}
	for _, suffix := range []string{"/open", "/status", "/close"} {
		if s, _ := h.call("POST", route+suffix, token, gin.H{"status": "ready"}); s != 404 {
			t.Fatal("removed account remained writable", suffix, s)
		}
	}
	if s, _ := h.call("POST", "/client/accounts", token, body); s != 409 {
		t.Fatal("retry resurrected removed account", s)
	}
	if newID := h.commerceCall(t, "POST", "/client/accounts", token, next)["id"]; newID == account {
		t.Fatal("new account reused ID")
	}
	var count int
	if err := h.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM customer_conversations WHERE account_id=$1`, account).Scan(&count); err != nil || count != 1 {
		t.Fatal("customer history deleted", err, count)
	}
	_, accounts = h.call("GET", "/client/accounts", token, nil)
	for _, item := range accounts["data"].([]any) {
		if item.(map[string]any)["id"] == account {
			t.Fatal("removed account listed")
		}
	}
	if s, _ := h.call("POST", "/client/tools/customer", token, gin.H{"accountId": account, "identifier": "447410419512"}); s != 404 {
		t.Fatal("removed account tools accessible", s)
	}
}

func TestCloudAccountRemovalOnlyAffectsCurrentDevice(t *testing.T) {
	h := setupCloud(t)
	number := h.number(t, "200001")
	code, token := h.codeClient(t)
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+number+"/assignments", h.admin, gin.H{"codeIds": []string{code}})
	secret := h.commerceCall(t, "POST", "/login-codes/"+code+"/copy", h.admin, gin.H{})["code"].(string)
	_, login := h.login(secret, "other-api-device")
	other := login["data"].(map[string]any)["accessToken"].(string)
	route := "/client/accounts/" + number
	chats := "/client/whatsapp-cloud/numbers/" + number + "/chats"
	if s, _ := h.call("POST", route+"/remove", token, gin.H{}); s != 409 {
		t.Fatal("cloud removal without close", s)
	}
	if s, d := h.call("POST", route+"/close", token, gin.H{}); s != 200 {
		t.Fatal(s, d)
	}
	if s, _ := h.call("GET", chats, token, nil); s != 404 {
		t.Fatal("closed chat still accessible", s)
	}
	if s, d := h.call("POST", route+"/remove", token, gin.H{}); s != 200 {
		t.Fatal(s, d)
	}
	if s, _ := h.call("POST", route+"/close", token, gin.H{}); s != 404 {
		t.Fatal("delayed close must not restore hidden number", s)
	}
	_, list := h.call("GET", "/client/accounts", token, nil)
	if row := list["data"].([]any)[0].(map[string]any); row["hidden"] != true || row["paused"] != true {
		t.Fatal("cloud account not hidden", row)
	}
	if s, _ := h.call("GET", chats, other, nil); s != 200 {
		t.Fatal("other device affected", s)
	}
	var assigned, enabled bool
	if err := h.app.DB.QueryRow(context.Background(), `SELECT n.enabled,EXISTS(SELECT 1 FROM wa_cloud_assignments WHERE number_id=n.id AND code_id=$2) FROM wa_cloud_numbers n WHERE n.id=$1`, number, code).Scan(&enabled, &assigned); err != nil || !enabled || !assigned {
		t.Fatal("shared number modified", err)
	}
	if s, d := h.call("POST", route+"/restore", token, gin.H{}); s != 200 {
		t.Fatal(s, d)
	}
	if s, _ := h.call("GET", chats, token, nil); s != 200 {
		t.Fatal("restore failed", s)
	}
	_, foreignToken := h.codeClient(t)
	if s, _ := h.call("POST", route+"/remove", foreignToken, gin.H{}); s != 404 {
		t.Fatal("other login code removed number", s)
	}
	// A removed assignment may not be restored by the old client.
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+number+"/assignments", h.admin, gin.H{"codeIds": []string{}})
	if s, _ := h.call("POST", route+"/restore", token, gin.H{}); s != 404 {
		t.Fatal("unassigned number restored", s)
	}
}
