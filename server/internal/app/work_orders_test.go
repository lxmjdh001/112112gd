package app

import (
	"context"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"strings"
	"testing"
	"time"
)

func TestWorkOrderStatisticsAndSharing(t *testing.T) {
	h := setup(t)
	code, raw := h.code(t)
	_, login := h.login(raw, "orders-client")
	client := login["data"].(map[string]any)["accessToken"].(string)
	ctx := context.Background()
	var tenant, device string
	if e := h.app.DB.QueryRow(ctx, `SELECT tenant_id::text,id::text FROM devices WHERE code_id=$1`, code).Scan(&tenant, &device); e != nil {
		t.Fatal(e)
	}
	account := func(n int) string {
		id := h.commerceCall(t, "POST", "/client/accounts", client, gin.H{"label": "统计账号", "platform": "whatsapp", "proxyId": "", "requestId": key(n)})["id"].(string)
		if _, e := h.app.DB.Exec(ctx, `UPDATE platform_accounts SET device_id=$2,billing_identity='8613800000000' WHERE id=$1`, id, device); e != nil {
			t.Fatal(e)
		}
		return id
	}
	a, b, zero := account(9201), account(9202), account(9203)
	now := time.Now().UTC()
	today := workOrderDayStart(now, 0)
	start := today.Add(-72 * time.Hour)
	payload := gin.H{"name": "渠道统计", "accountIds": []string{a, b, zero}, "startAt": start, "enabled": true, "password": "test-pass", "target": 100}
	order := h.commerceCall(t, "POST", "/work-orders", h.admin, payload)["id"].(string)
	// Real message metadata only. Repeated/retried messages never add more people.
	ingest := func(account, id, customer string, at time.Time) {
		t.Helper()
		body := gin.H{"owner": "8613800000000", "ready": true, "events": []gin.H{{"id": id, "customer": customer, "at": at}}}
		h.commerceCall(t, "POST", "/client/accounts/"+account+"/inbound-events", client, body)
	}
	ingest(a, "old-window", "447700900001", start.Add(-time.Hour))
	ingest(a, "a-yesterday", "447700900001", today.Add(-time.Hour))
	ingest(a, "a-today", "447700900001", today)
	ingest(a, "a-today", "447700900001", today)
	ingest(a, "second", "447700900002", today)
	ingest(b, "duplicate", "447700900001", today)
	// This manual customer record is not an inbound message and must not count.
	h.commerceCall(t, "POST", "/client/conversations", client, gin.H{"accountId": zero, "identifier": "447700900003"})
	s, e := h.app.calculateWorkOrderStats(ctx, tenant, order, now)
	if e != nil {
		t.Fatal(e)
	}
	if s.Total != 3 || s.Yesterday != 1 || s.Today != 2 || s.Duplicate != 1 || s.Fresh != 2 || len(s.Accounts) != 3 {
		t.Fatalf("incorrect counts: %+v", s)
	}
	for _, v := range s.Accounts {
		if v.ID == zero && (v.Total != 0 || v.CollectorReady) {
			t.Fatal("unobserved account should be zero with pending status", v)
		}
	}
	// Earliest message can arrive late; recomputation must move the daily bucket.
	ingest(a, "late", "447700900002", today.Add(-2*time.Hour))
	s, e = h.app.calculateWorkOrderStats(ctx, tenant, order, now)
	if e != nil || s.Today != 1 || s.Yesterday != 2 {
		t.Fatal(s, e)
	}
	// A WhatsApp LID can resolve to an already counted phone later. Reconcile history,
	// including a retry of the exact same message, without adding another person.
	aliasPayload := gin.H{"owner": "8613800000000", "ready": true, "events": []gin.H{{"id": "lid-event", "customer": "lid:12345678901234", "at": today}}}
	h.commerceCall(t, "POST", "/client/accounts/"+a+"/inbound-events", client, aliasPayload)
	s, e = h.app.calculateWorkOrderStats(ctx, tenant, order, now)
	if e != nil || s.Total != 4 {
		t.Fatal(s, e)
	}
	aliasPayload["events"].([]gin.H)[0]["phone"] = "447700900002"
	h.commerceCall(t, "POST", "/client/accounts/"+a+"/inbound-events", client, aliasPayload)
	s, e = h.app.calculateWorkOrderStats(ctx, tenant, order, now)
	if e != nil || s.Total != 3 || s.Yesterday != 2 {
		t.Fatal("LID/phone counted twice", s, e)
	}
	// Removed accounts preserve historical counts.
	if _, e = h.app.DB.Exec(ctx, `UPDATE platform_accounts SET removed_at=now() WHERE id=$1`, b); e != nil {
		t.Fatal(e)
	}
	s, e = h.app.calculateWorkOrderStats(ctx, tenant, order, now)
	if e != nil || s.Total != 3 {
		t.Fatal(s, e)
	}
	_, list := h.call("GET", "/work-orders", h.admin, nil)
	token := list["data"].([]any)[0].(map[string]any)["token"].(string)
	if status, _ := h.call("POST", "/public/work-orders/"+token, "", gin.H{}); status != 403 {
		t.Fatal("password not enforced", status)
	}
	data := h.commerceCall(t, "POST", "/public/work-orders/"+token, "", gin.H{"password": "test-pass"})
	bytes, _ := json.Marshal(data)
	if strings.Contains(string(bytes), "447700") || strings.Contains(string(bytes), "test-pass") || strings.Contains(string(bytes), "token") {
		t.Fatal("private data leaked", string(bytes))
	}
	replacement := h.commerceCall(t, "POST", "/work-orders/"+order+"/rotate", h.admin, gin.H{})["token"].(string)
	if status, _ := h.call("POST", "/public/work-orders/"+token, "", gin.H{"password": "test-pass"}); status != 404 {
		t.Fatal("old link remains valid")
	}
	payload["enabled"] = false
	h.commerceCall(t, "PUT", "/work-orders/"+order, h.admin, payload)
	if status, _ := h.call("POST", "/public/work-orders/"+replacement, "", gin.H{"password": "test-pass"}); status != 404 {
		t.Fatal("disabled link remains valid")
	}
	payload["enabled"] = true
	payload["expiresAt"] = now.Add(-time.Hour)
	h.commerceCall(t, "PUT", "/work-orders/"+order, h.admin, payload)
	if status, _ := h.call("POST", "/public/work-orders/"+replacement, "", gin.H{"password": "test-pass"}); status != 404 {
		t.Fatal("expired link remains valid")
	}
	// Company and device boundaries, even if a valid record ID is known.
	var other string
	if e = h.app.DB.QueryRow(ctx, `INSERT INTO tenants(name) VALUES('other') RETURNING id::text`).Scan(&other); e != nil {
		t.Fatal(e)
	}
	if _, e = h.app.calculateWorkOrderStats(ctx, other, order, now); e == nil {
		t.Fatal("cross tenant read")
	}
	if status, _ := h.call("POST", "/work-orders", client, payload); status != 401 {
		t.Fatal("client can create orders")
	}
	_, otherLogin := h.login(raw, "other-device")
	otherClient := otherLogin["data"].(map[string]any)["accessToken"].(string)
	if status, _ := h.call("POST", "/client/accounts/"+a+"/inbound-events", otherClient, gin.H{"owner": "8613800000000", "ready": true}); status != 404 {
		t.Fatal("other device can submit", status)
	}
	if status, _ := h.call("POST", "/client/accounts/"+a+"/inbound-events", client, gin.H{"owner": "8613800000001", "ready": true}); status != 409 {
		t.Fatal("owner mismatch accepted", status)
	}
	// A body-supplied ID must never turn create into update.
	payload["accountIds"] = []string{a, zero}
	payload["id"] = order
	created := h.commerceCall(t, "POST", "/work-orders", h.admin, payload)["id"].(string)
	if created == order {
		t.Fatal("request ID overrode route")
	}
	h.commerceCall(t, "DELETE", "/work-orders/"+order, h.admin, nil)
	if _, e = h.app.calculateWorkOrderStats(ctx, tenant, order, now); e == nil {
		t.Fatal("deleted work order still exists")
	}
}
func TestWorkOrderBeijingReset(t *testing.T) {
	for _, tt := range []struct {
		now   string
		reset int
		want  string
	}{
		{"2026-10-12T15:59:59Z", 0, "2026-10-11T16:00:00Z"},
		{"2026-10-12T16:00:00Z", 0, "2026-10-12T16:00:00Z"},
		{"2026-10-12T18:59:59Z", 180, "2026-10-11T19:00:00Z"},
		{"2026-10-12T19:00:00Z", 180, "2026-10-12T19:00:00Z"},
	} {
		at, _ := time.Parse(time.RFC3339, tt.now)
		got := workOrderDayStart(at, tt.reset).UTC().Format(time.RFC3339)
		if got != tt.want {
			t.Fatalf("%s => %s, want %s", tt.now, got, tt.want)
		}
	}
}

func TestWorkOrderCloudWebhookAndGroups(t *testing.T) {
	h := setupCloud(t)
	number := h.number(t, "200001")
	code, _ := h.codeClient(t)
	ctx := context.Background()
	var tenant string
	if e := h.app.DB.QueryRow(ctx, `SELECT tenant_id::text FROM wa_cloud_numbers WHERE id=$1`, number).Scan(&tenant); e != nil {
		t.Fatal(e)
	}
	var group string
	if e := h.app.DB.QueryRow(ctx, `INSERT INTO login_code_groups(tenant_id,name) VALUES($1,'API 分组') RETURNING id::text`, tenant).Scan(&group); e != nil {
		t.Fatal(e)
	}
	if _, e := h.app.DB.Exec(ctx, `UPDATE login_codes SET group_id=$2 WHERE id=$1`, code, group); e != nil {
		t.Fatal(e)
	}
	if _, e := h.app.DB.Exec(ctx, `INSERT INTO wa_cloud_assignments(tenant_id,number_id,code_id) VALUES($1,$2,$3)`, tenant, number, code); e != nil {
		t.Fatal(e)
	}
	status, options := h.call("GET", "/work-orders/options", h.admin, nil)
	if status != 200 {
		t.Fatal(options)
	}
	raw, _ := json.Marshal(options)
	if !strings.Contains(string(raw), group) || !strings.Contains(string(raw), "API 分组") {
		t.Fatal("cloud assignments not included in group options", options)
	}
	now := time.Now().UTC()
	start := workOrderDayStart(now, 0)
	order := h.commerceCall(t, "POST", "/work-orders", h.admin, gin.H{"name": "API 进线", "accountIds": []string{number}, "startAt": start, "enabled": true})["id"].(string)
	h.receive(t, number, "200001", "wamid.stats.1", "447700900001", now.Add(-time.Second))
	h.receive(t, number, "200001", "wamid.stats.2", "447700900001", now.Add(-time.Second))
	s, e := h.app.calculateWorkOrderStats(ctx, tenant, order, now)
	if e != nil || s.Total != 1 || s.Today != 1 {
		t.Fatal(s, e)
	}
}
