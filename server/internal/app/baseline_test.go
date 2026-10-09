package app

import (
	"context"
	"fmt"
	"github.com/gin-gonic/gin"
	"strings"
	"sync"
	"testing"
)

func TestBaselineNormalization(t *testing.T) {
	for _, tc := range []struct{ platform, input, ip, want, wantIP string }{
		{"whatsapp", "+44 (7410) 419-512", "", "447410419512", ""},
		{"whatsapp", "447410419512@s.whatsapp.net", "::ffff:203.0.113.1", "447410419512", "203.0.113.1"},
		{"whatsapp", "47846556438532@lid", "2001:0db8:0000::1", "47846556438532@lid", "2001:db8::1"},
		{"line", "customer.id", "", "customer.id", ""},
		{"whatsapp", "", "203.0.113.2", "", "203.0.113.2"},
	} {
		id, ip, e := normalizeCustomer(tc.platform, tc.input, tc.ip)
		if e != nil || id != tc.want || ip != tc.wantIP {
			t.Fatalf("normalize %+v: %s %s %v", tc, id, ip, e)
		}
	}
	for _, tc := range []struct{ platform, id, ip string }{
		{"whatsapp", "Zzzzz", ""}, {"whatsapp", "0@s.whatsapp.net", ""}, {"whatsapp", "1234@g.us", ""}, {"whatsapp", "", "10.1.2.3"}, {"whatsapp", "", "127.0.0.1"}, {"whatsapp", "", "fe80::1%en0"}, {"whatsapp", "", "8.8.8.8:80"}, {"whatsapp", "", ""}, {"telegram", "1234567", ""},
	} {
		if _, _, e := normalizeCustomer(tc.platform, tc.id, tc.ip); e == nil {
			t.Fatalf("accepted %+v", tc)
		}
	}
	rows, e := baselineRows("whatsapp", "\ufeff客户账号,客户IP,备注\r\n+44 7410419512,,\"备注,含逗号\"\r\nwrong,,\n,2001:db8::1,\n")
	if e != nil || len(rows) != 3 || rows[0].Identifier != "447410419512" || rows[0].Note != "备注,含逗号" || rows[1].Error == "" || rows[2].IP != "2001:db8::1" {
		t.Fatalf("csv: %+v %v", rows, e)
	}
	if _, e = baselineRows("whatsapp", strings.Repeat("447410419512\n", 1001)); e == nil {
		t.Fatal("oversize accepted")
	}
}
func baselineFixtures(t *testing.T, h *harness) (string, string, []string) {
	t.Helper()
	ctx := context.Background()
	code, raw := h.code(t)
	s, d := h.login(raw, "baseline-client")
	if s != 200 {
		t.Fatal(d)
	}
	auth := d["data"].(map[string]any)
	token := auth["accessToken"].(string)
	device := auth["deviceId"].(string)
	var tenant, proxy string
	if e := h.app.DB.QueryRow(ctx, `SELECT tenant_id::text FROM login_codes WHERE id=$1`, code).Scan(&tenant); e != nil {
		t.Fatal(e)
	}
	if e := h.app.DB.QueryRow(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher) VALUES($1,'test','socks5','example.test',1080,'','') RETURNING id::text`, tenant).Scan(&proxy); e != nil {
		t.Fatal(e)
	}
	ids := []string{}
	for i := 0; i < 4; i++ {
		var id string
		platform := "whatsapp"
		if i == 3 {
			platform = "line"
		}
		if e := h.app.DB.QueryRow(ctx, `INSERT INTO platform_accounts(tenant_id,code_id,proxy_id,device_id,platform,label) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`, tenant, code, proxy, device, platform, fmt.Sprintf("客服%d", i+1)).Scan(&id); e != nil {
			t.Fatal(e)
		}
		ids = append(ids, id)
	}
	return token, tenant, ids
}
func TestBaselineImportDedupeAndConversationRecalculation(t *testing.T) {
	h := setup(t)
	client, tenant, accounts := baselineFixtures(t, h)
	payload := gin.H{"platform": "whatsapp", "text": "客户账号,客户IP,备注\n+44 7410419512,203.0.113.4,已有客户\n447410419512@s.whatsapp.net,203.0.113.4,重复行\nwrong,,无效\n,2001:db8::1,仅IP", "accountId": accounts[0], "requestId": key(800)}
	preview := h.commerceCall(t, "POST", "/baselines/preview", h.admin, payload)
	if preview["added"] != float64(2) || preview["invalid"] != float64(1) || preview["skipped"] != float64(1) {
		t.Fatal(preview)
	}
	var wg sync.WaitGroup
	results := make(chan map[string]any, 5)
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, b := h.call("POST", "/baselines/import", h.admin, payload)
			if s != 200 {
				b["failed"] = s
			}
			results <- b
		}()
	}
	wg.Wait()
	close(results)
	batch := ""
	for b := range results {
		if b["failed"] != nil {
			t.Fatal(b)
		}
		v := b["data"].(map[string]any)
		if v["added"] != float64(2) || v["skipped"] != float64(1) {
			t.Fatal(v)
		}
		if batch != "" && batch != v["id"].(string) {
			t.Fatal("retry batch differs")
		}
		batch = v["id"].(string)
	}
	payload["text"] = "447410419599"
	if s, _ := h.call("POST", "/baselines/import", h.admin, payload); s != 409 {
		t.Fatal("import id reused", s)
	}
	check := func(platform, id, ip string) map[string]any {
		return h.commerceCall(t, "POST", "/baselines/check", h.admin, gin.H{"platform": platform, "identifier": id, "ip": ip})
	}
	if m := check("whatsapp", "447410419512", ""); m["duplicateAccount"] != true || m["duplicateIP"] != false {
		t.Fatal(m)
	}
	if m := check("whatsapp", "447410419599", "2001:0db8::1"); m["duplicateAccount"] != false || m["duplicateIP"] != true {
		t.Fatal("IP should flag separately", m)
	}
	if m := check("line", "447410419512", "203.0.113.4"); m["duplicateAccount"] != false || m["duplicateIP"] != false {
		t.Fatal("cross platform match", m)
	}
	if m := check("whatsapp", "47846556438532@lid", ""); m["duplicateAccount"] != false {
		t.Fatal("guessed LID mapping", m)
	}
	rec := func(account, id, ip string) map[string]any {
		return h.commerceCall(t, "POST", "/client/conversations", client, gin.H{"accountId": account, "identifier": id, "ip": ip, "platform": "line", "tenantId": "forged"})
	}
	if m := rec(accounts[1], "447410419512", "")["match"].(map[string]any); m["duplicateAccount"] != true {
		t.Fatal(m)
	}
	first := rec(accounts[0], "447410419600", "")
	if first["match"].(map[string]any)["duplicateAccount"] != false {
		t.Fatal("first not new")
	}
	if rec(accounts[0], "+44 7410419600", "")["existing"] != true {
		t.Fatal("retry recounted")
	}
	if m := rec(accounts[1], "447410419600", "")["match"].(map[string]any); m["duplicateAccount"] != true || m["historyMatch"] != true {
		t.Fatal("cross service account not duplicate", m)
	}

	current := h.commerceCall(t, "POST", "/client/customers/check", client, gin.H{"accountId": accounts[0], "identifier": "447410419600"})
	if current["duplicateAccount"] != false {
		t.Fatal("current chat matched itself or a later chat", current)
	}
	later := h.commerceCall(t, "POST", "/client/customers/check", client, gin.H{"accountId": accounts[1], "identifier": "447410419600"})
	if later["duplicateAccount"] != true {
		t.Fatal("later chat missed first contact", later)
	}
	h.commerceCall(t, "POST", "/baselines/import", h.admin, gin.H{"platform": "whatsapp", "text": "447410419600", "requestId": key(801)})
	h.commerceCall(t, "POST", "/conversations/recalculate", h.admin, gin.H{"platform": "whatsapp"})
	rows := h.commerceCall(t, "GET", "/conversations?search=447410419600", h.admin, nil)["items"].([]any)
	for _, r := range rows {
		if r.(map[string]any)["duplicateAccount"] != true || r.(map[string]any)["baselineMatch"] != true {
			t.Fatal("recalc missed", r)
		}
	}
	entries := h.commerceCall(t, "GET", "/baselines?search=447410419600", h.admin, nil)["items"].([]any)
	entry := entries[0].(map[string]any)["id"].(string)
	h.commerceCall(t, "PATCH", "/baselines/"+entry, h.admin, gin.H{"enabled": false, "note": "已停用"})
	h.commerceCall(t, "POST", "/conversations/recalculate", h.admin, gin.H{"platform": "whatsapp"})
	var repeated bool
	if e := h.app.DB.QueryRow(context.Background(), `SELECT duplicate_account FROM customer_conversations WHERE id=$1`, first["id"]).Scan(&repeated); e != nil || repeated {
		t.Fatal("inactive baseline or self match", repeated, e)
	}
	summary := h.commerceCall(t, "GET", "/baselines/summary", h.admin, nil)
	if summary["conversations"] != float64(3) || summary["newUsers"] != float64(1) || summary["repeatedUsers"] != float64(2) {
		t.Fatal(summary)
	}
	var count int
	h.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM baseline_batches WHERE tenant_id=$1`, tenant).Scan(&count)
	if count != 2 {
		t.Fatal("duplicate batches", count)
	}
	if s, _ := h.call("POST", "/client/conversations", client, gin.H{"accountId": accounts[0], "ip": "203.0.113.8"}); s != 400 {
		t.Fatal("IP-only conversation accepted", s)
	}
	h.app.DB.Exec(context.Background(), `UPDATE proxies SET enabled=false WHERE tenant_id=$1`, tenant)
	if s, _ := h.call("POST", "/client/customers/check", client, gin.H{"accountId": accounts[0], "identifier": "447410419512"}); s != 404 {
		t.Fatal("disabled proxy bypass", s)
	}
}
func TestBaselineConcurrentFirstContactsAndTenantIsolation(t *testing.T) {
	h := setup(t)
	client, tenant, accounts := baselineFixtures(t, h)
	var wg sync.WaitGroup
	results := make(chan map[string]any, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s, d := h.call("POST", "/client/conversations", client, gin.H{"accountId": accounts[i%3], "identifier": "447410400001"})
			if s != 200 {
				d["failed"] = s
			}
			results <- d
		}(i)
	}
	wg.Wait()
	close(results)
	for d := range results {
		if d["failed"] != nil {
			t.Fatal(d)
		}
	}
	summary := h.commerceCall(t, "GET", "/baselines/summary", h.admin, nil)
	if summary["conversations"] != float64(3) || summary["newUsers"] != float64(1) || summary["repeatedUsers"] != float64(2) {
		t.Fatal("concurrent first contacts", summary)
	}
	h.commerceConfig(t)
	other := h.member(t, "baseline-outsider", "")
	if data := h.commerceCall(t, "GET", "/baselines/summary", other, nil); data["conversations"] != float64(0) {
		t.Fatal("tenant leakage", data)
	}
	if s, _ := h.call("POST", "/conversations", other, gin.H{"accountId": accounts[0], "identifier": "447410400002"}); s != 404 {
		t.Fatal("foreign account accepted", s)
	}
	if s, _ := h.call("POST", "/baselines/import", other, gin.H{"platform": "whatsapp", "text": "447410400002", "accountId": accounts[0], "requestId": key(888)}); s != 400 {
		t.Fatal("foreign source accepted", s)
	}
	h.commerceCall(t, "POST", "/baselines/import", h.admin, gin.H{"platform": "whatsapp", "text": "447410400002", "requestId": key(889)})
	entry := h.commerceCall(t, "GET", "/baselines", h.admin, nil)["items"].([]any)[0].(map[string]any)["id"].(string)
	if s, _ := h.call("PATCH", "/baselines/"+entry, other, gin.H{"enabled": false}); s != 404 {
		t.Fatal("foreign update", s)
	}
	m := h.commerceCall(t, "POST", "/baselines/check", other, gin.H{"platform": "whatsapp", "identifier": "447410400002", "tenantId": tenant})
	if m["duplicateAccount"] != false {
		t.Fatal("foreign lookup leak", m)
	}
	if s, _ := h.call("GET", "/baselines", client, nil); s != 401 {
		t.Fatal("client bulk-read allowed", s)
	}
	h.commerceCall(t, "POST", "/baselines/import", h.admin, gin.H{"platform": "line", "text": "line.customer", "requestId": key(890)})
	if m := h.commerceCall(t, "POST", "/baselines/check", h.admin, gin.H{"platform": "line", "identifier": "line.customer"}); m["duplicateAccount"] != true {
		t.Fatal("future LINE storage", m)
	}
}
