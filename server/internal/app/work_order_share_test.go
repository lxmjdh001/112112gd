package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type publicWorkOrderFixture struct {
	h                                 *harness
	client, code, device, tenant, raw string
	next                              int
}

func publicWorkOrderClient(t *testing.T, h *harness) *publicWorkOrderFixture {
	t.Helper()
	code, raw := h.code(t)
	status, login := h.login(raw, "share-presence-client")
	if status != 200 {
		t.Fatal(status, login)
	}
	data := login["data"].(map[string]any)
	f := &publicWorkOrderFixture{h: h, client: data["accessToken"].(string), device: data["deviceId"].(string), code: code, raw: raw, next: 98500}
	if err := h.app.DB.QueryRow(context.Background(), `UPDATE login_codes SET allowed_platforms='{whatsapp,line,telegram}' WHERE id=$1 RETURNING tenant_id::text`, code).Scan(&f.tenant); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *publicWorkOrderFixture) account(t *testing.T, label, platform, identifier string, now time.Time) string {
	t.Helper()
	f.next++
	account := f.h.commerceCall(t, "POST", "/client/accounts", f.client, gin.H{"label": label, "platform": platform, "proxyId": "", "requestId": key(f.next)})["id"].(string)
	if _, err := f.h.app.DB.Exec(context.Background(), `UPDATE platform_accounts SET device_id=$2,billing_identity=$3,observed_status='ready',observed_at=$4 WHERE id=$1`, account, f.device, identifier, now); err != nil {
		t.Fatal(err)
	}
	return account
}

func publicWorkOrderToken(t *testing.T, h *harness, id string) string {
	t.Helper()
	status, response := h.call("GET", "/work-orders", h.admin, nil)
	if status != 200 {
		t.Fatal(status, response)
	}
	for _, item := range response["data"].([]any) {
		row := item.(map[string]any)
		if row["id"] == id {
			return row["token"].(string)
		}
	}
	t.Fatal("missing work order", id)
	return ""
}

func TestPublicWorkOrderDailyClassificationIdentityAndPrivacy(t *testing.T) {
	h := setup(t)
	f := publicWorkOrderClient(t, h)
	ctx := context.Background()
	now := time.Now().UTC()
	today := workOrderDayStart(now, 0)
	a := f.account(t, "Alice 的备注", "whatsapp", "8613800000001", now)
	b := f.account(t, "Bob 的备注", "whatsapp", "8613800000002", now)
	stale := f.account(t, "已断开", "whatsapp", "8613800000003", now)
	line := f.account(t, "LINE 客服", "line", "u"+strings.Repeat("a", 32), now)
	f.account(t, "PRIVATE-UNSELECTED", "whatsapp", "8613999999999", now)
	if _, err := h.app.DB.Exec(ctx, `UPDATE devices SET last_seen=$2 WHERE id=$1`, f.device, now); err != nil {
		t.Fatal(err)
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE platform_accounts SET observed_status='network_error' WHERE id=$1`, b); err != nil {
		t.Fatal(err)
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE platform_accounts SET observed_at=$2 WHERE id=$1`, stale, now.Add(-91*time.Second)); err != nil {
		t.Fatal(err)
	}
	// Collector readiness is intentionally opposite to presence in these rows.
	for _, account := range []string{b, stale} {
		if _, err := h.app.DB.Exec(ctx, `INSERT INTO account_stats_sync(tenant_id,account_id,collector_ready) VALUES($1,$2,true)`, f.tenant, account); err != nil {
			t.Fatal(err)
		}
	}
	order := h.commerceCall(t, "POST", "/work-orders", h.admin, gin.H{"name": "销售分享", "accountIds": []string{a, b, stale, line}, "startAt": today.Add(-72 * time.Hour), "dedupBaseline": true, "enabled": true, "password": "share-password"})["id"].(string)
	if _, err := h.app.DB.Exec(ctx, `INSERT INTO baseline_entries(tenant_id,platform,identifier) VALUES($1,'whatsapp','447700900004')`, f.tenant); err != nil {
		t.Fatal(err)
	}
	for i, event := range []struct {
		account, customer string
		at                time.Time
	}{
		{a, "447700900001", today.Add(-time.Hour)},
		{a, "447700900002", today},
		{a, "447700900004", today.Add(-2 * time.Hour)},
		{b, "447700900001", today},
		{b, "447700900003", today.Add(-time.Hour)},
		{b, "447700900004", today},
		// A repeat message on an existing contact changes neither daily bucket.
		{a, "447700900001", today},
	} {
		if _, err := h.app.DB.Exec(ctx, `INSERT INTO account_inbound_events(tenant_id,account_id,event_id,customer_id,occurred_at) VALUES($1,$2,$3,$4,$5)`, f.tenant, event.account, fmt.Sprintf("shared-%d", i), event.customer, event.at); err != nil {
			t.Fatal(err)
		}
	}
	stats, err := h.app.calculateWorkOrderStats(ctx, f.tenant, order, now)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Total != 6 || stats.Fresh != 3 || stats.Duplicate != 3 || stats.Today != 3 || stats.TodayFresh != 1 || stats.TodayDuplicate != 2 || stats.Yesterday != 3 {
		t.Fatalf("daily/cumulative classifications differ: %+v", stats)
	}
	byID := map[string]workOrderAccountStats{}
	for _, row := range stats.Accounts {
		byID[row.ID] = row
	}
	if row := byID[a]; row.Nickname != "Alice 的备注" || row.Account != "8613800000001" || row.Status != "online" || row.CollectorReady || row.TodayFresh != 1 || row.TodayDuplicate != 0 || row.Fresh != 2 || row.Duplicate != 1 {
		t.Fatal("fresh row identity/presence", row)
	}
	if row := byID[b]; row.Status != "error" || !row.CollectorReady || row.TodayDuplicate != 2 || row.TodayFresh != 0 || row.Duplicate != 2 {
		t.Fatal("today duplicates must not use cumulative duplicates", row)
	}
	if row := byID[stale]; row.Status != "offline" || !row.CollectorReady {
		t.Fatal("collector activity must not imply account online", row)
	}
	if strings.Join(stats.Platforms, ",") != "whatsapp,line" {
		t.Fatal("platform header", stats.Platforms)
	}
	token := publicWorkOrderToken(t, h, order)
	if status, data := h.call("POST", "/public/work-orders/"+token, "", gin.H{"password": "incorrect"}); status != 403 || data["data"] != nil {
		t.Fatal("password no longer protects identity", status, data)
	}
	shared := h.commerceCall(t, "POST", "/public/work-orders/"+token, "", gin.H{"password": "share-password"})
	if shared["todayFresh"] != float64(1) || shared["todayDuplicate"] != float64(2) || len(shared["accounts"].([]any)) != 4 {
		t.Fatal(shared)
	}
	encoded, err := json.Marshal(shared)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{f.raw, f.client, f.code, f.device, token, "share-password", "4477009000", "PRIVATE-UNSELECTED", "8613999999999", "password_hash", "token_cipher", "identity_hash", "proxyHost"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("public share exposed %q: %s", forbidden, encoded)
		}
	}
	if !strings.Contains(string(encoded), "8613800000001") {
		t.Fatal("authorized account phone is missing", string(encoded))
	}
	var foreignTenant string
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO tenants(name) VALUES('foreign work order owner') RETURNING id::text`).Scan(&foreignTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := h.app.calculateWorkOrderStats(ctx, foreignTenant, order, now); err != pgx.ErrNoRows {
		t.Fatal("tenant scope changed", err)
	}
}

func TestPublicWorkOrderPresenceNinetySecondBoundary(t *testing.T) {
	now := time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC)
	fresh, boundary, expired := now, now.Add(-90*time.Second), now.Add(-90*time.Second-time.Nanosecond)
	for _, tt := range []struct {
		name, state string
		at, seen    *time.Time
		active      bool
		available   bool
		stopped     bool
		want        string
	}{
		{"ready", "ready", &fresh, &fresh, true, true, false, "online"},
		{"exactly 90 seconds", "ready", &boundary, &boundary, true, true, false, "online"},
		{"expired account", "ready", &expired, &fresh, true, true, false, "offline"},
		{"expired device", "ready", &fresh, &expired, true, true, false, "offline"},
		{"inactive device", "ready", &fresh, &fresh, false, true, false, "offline"},
		{"no account observation", "ready", nil, &fresh, true, true, false, "offline"},
		{"no device heartbeat", "ready", &fresh, nil, true, true, false, "offline"},
		{"connecting", "loading", &fresh, &fresh, true, true, false, "offline"},
		{"logged out", "qr_required", &fresh, &fresh, true, true, false, "offline"},
		{"closed", "closed", &fresh, &fresh, true, true, false, "offline"},
		{"never opened", "not_opened", nil, nil, false, true, false, "offline"},
		{"network failure", "network_error", &fresh, &fresh, true, true, false, "error"},
		{"unknown current state", "unknown", &fresh, &fresh, true, true, false, "error"},
		{"stale error", "network_error", &expired, &fresh, true, true, false, "offline"},
		{"authorization/proxy unavailable", "ready", &fresh, &fresh, true, false, false, "error"},
		{"paused or removed", "ready", &fresh, &fresh, true, true, true, "offline"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := workOrderPresenceStatus(now, tt.state, tt.at, tt.seen, tt.active, tt.available, tt.stopped); got != tt.want {
				t.Fatalf("got %s, want %s", got, tt.want)
			}
		})
	}
}

func TestPublicWorkOrderPresenceUsesAccountAndDeviceAuthorization(t *testing.T) {
	h := setup(t)
	f := publicWorkOrderClient(t, h)
	ctx := context.Background()
	now := time.Now().UTC()
	account := f.account(t, "presence", "whatsapp", "8613800000011", now)
	order := h.commerceCall(t, "POST", "/work-orders", h.admin, gin.H{"name": "presence", "accountIds": []string{account}, "startAt": now.Add(-time.Hour), "enabled": true})["id"].(string)
	if _, err := h.app.DB.Exec(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher,enabled) VALUES($1,'disabled-shared-proxy','socks5','localhost',1080,'','',false)`, f.tenant); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name, sql, want string
	}{
		{"active", "", "online"},
		{"account stale", `UPDATE platform_accounts SET observed_at=$2::timestamptz-interval '91 seconds' WHERE id=$1`, "offline"},
		{"device stale", `UPDATE devices SET last_seen=$2::timestamptz-interval '91 seconds' WHERE id=(SELECT device_id FROM platform_accounts WHERE id=$1)`, "offline"},
		{"device inactive", `UPDATE devices SET active=false,last_seen=$2 WHERE id=(SELECT device_id FROM platform_accounts WHERE id=$1)`, "offline"},
		{"paused", `UPDATE platform_accounts SET paused_at=$2 WHERE id=$1`, "offline"},
		{"removed", `UPDATE platform_accounts SET removed_at=$2 WHERE id=$1`, "offline"},
		{"proxy disabled", `UPDATE platform_accounts SET proxy_id=(SELECT id FROM proxies WHERE label='disabled-shared-proxy'),observed_at=$2 WHERE id=$1`, "error"},
		{"code disabled", `UPDATE login_codes SET enabled=false,expires_at=$2::timestamptz+interval '1 hour' WHERE id=(SELECT code_id FROM platform_accounts WHERE id=$1)`, "error"},
		{"code deleted", `UPDATE login_codes SET deleted_at=$2,enabled=false WHERE id=(SELECT code_id FROM platform_accounts WHERE id=$1)`, "error"},
		{"code expired", `UPDATE login_codes SET expires_at=$2::timestamptz-interval '1 second' WHERE id=(SELECT code_id FROM platform_accounts WHERE id=$1)`, "error"},
		{"platform revoked", `UPDATE login_codes SET allowed_platforms='{}',expires_at=$2::timestamptz+interval '1 hour' WHERE id=(SELECT code_id FROM platform_accounts WHERE id=$1)`, "error"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			for _, reset := range []string{
				`UPDATE platform_accounts SET observed_status='ready',observed_at=$2,removed_at=NULL,paused_at=NULL,proxy_id=NULL WHERE id=$1`,
				`UPDATE devices SET active=true,last_seen=$2 WHERE id=(SELECT device_id FROM platform_accounts WHERE id=$1)`,
				`UPDATE login_codes SET enabled=true,deleted_at=NULL,allowed_platforms='{whatsapp}',expires_at=$2::timestamptz+interval '1 hour' WHERE id=(SELECT code_id FROM platform_accounts WHERE id=$1)`,
			} {
				if _, err := h.app.DB.Exec(ctx, reset, account, now); err != nil {
					t.Fatal(err)
				}
			}
			if tt.sql != "" {
				if _, err := h.app.DB.Exec(ctx, tt.sql, account, now); err != nil {
					t.Fatal(err)
				}
			}
			stats, err := h.app.calculateWorkOrderStats(ctx, f.tenant, order, now)
			if err != nil || len(stats.Accounts) != 1 || stats.Accounts[0].Status != tt.want {
				t.Fatal(stats, err)
			}
		})
	}
}

func TestPublicWorkOrderCloudIdentityAndChannelState(t *testing.T) {
	h := setupCloud(t)
	ctx := context.Background()
	now := time.Now().UTC()
	number := h.number(t, "200001")
	order := h.commerceCall(t, "POST", "/work-orders", h.admin, gin.H{"name": "Cloud 分享", "accountIds": []string{number}, "startAt": now.Add(-time.Hour), "enabled": true})["id"].(string)
	token := publicWorkOrderToken(t, h.harness, order)
	shared := h.commerceCall(t, "POST", "/public/work-orders/"+token, "", gin.H{})
	row := shared["accounts"].([]any)[0].(map[string]any)
	if row["nickname"] != "客服一" || row["account"] != "+15550000001" || row["status"] != "online" || shared["platforms"].([]any)[0] != "whatsapp_cloud" {
		t.Fatal(shared)
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE wa_cloud_numbers SET auth_status='invalid',last_error=$2 WHERE id=$1`, number, "PRIVATE-CLOUD-ERROR"); err != nil {
		t.Fatal(err)
	}
	shared = h.commerceCall(t, "POST", "/public/work-orders/"+token, "", gin.H{})
	if shared["accounts"].([]any)[0].(map[string]any)["status"] != "error" {
		t.Fatal(shared)
	}
	encoded, _ := json.Marshal(shared)
	for _, secret := range []string{cloudSecret, cloudToken, "PRIVATE-CLOUD-ERROR", "phoneId", "wabaId", "token_cipher"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatal("Cloud credentials/configuration leaked", string(encoded))
		}
	}
}
