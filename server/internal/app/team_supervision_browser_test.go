package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gongdan007/server/internal/security"
)

// This opt-in fixture uses setup's disposable schema and never starts a worker
// or connects an external account. Stop by creating dest+".stop" (15m maximum).
func TestTeamSupervisionBrowserFixture(t *testing.T) {
	dest := os.Getenv("GONGDAN_TEAM_PREVIEW_PATH")
	if dest == "" {
		t.Skip("team browser fixture not requested")
	}
	h := setup(t)
	h.commerceConfig(t)
	member := h.member(t, "team-preview-admin", "")
	team := &harness{app: h.app, r: h.r, admin: member}
	_, account := toolsClient(t, team, "Alice · 主账号")
	_, otherAccount := toolsClient(t, h, "外部团队账号")
	ctx := context.Background()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := h.app.DB.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	var tenant, codeID, otherTenant string
	if err := h.app.DB.QueryRow(ctx, `SELECT tenant_id::text,code_id::text FROM platform_accounts WHERE id=$1`, account).Scan(&tenant, &codeID); err != nil {
		t.Fatal(err)
	}
	if err := h.app.DB.QueryRow(ctx, `SELECT tenant_id::text FROM platform_accounts WHERE id=$1`, otherAccount).Scan(&otherTenant); err != nil {
		t.Fatal(err)
	}
	exec(`UPDATE login_codes SET label='Alice · 销售一组' WHERE id=$1`, codeID)
	exec(`UPDATE login_codes SET label='外部团队业务员' WHERE tenant_id=$1`, otherTenant)
	var secondAccount string
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO platform_accounts(tenant_id,code_id,platform,label) VALUES($1,$2,'whatsapp','Alice · 第二台设备') RETURNING id::text`, tenant, codeID).Scan(&secondAccount); err != nil {
		t.Fatal(err)
	}
	const customer = "15550001111"
	const outboundOnly = "15550002222"
	const metadataOnly = "15550003333"
	const profileOnly = "15550004444"
	const aliasCustomer = "15550005555"
	const otherCustomer = "15559999999"
	start := time.Date(2026, 10, 29, 23, 59, 0, 0, beijing)
	message := func(tenantID, accountID, id, peer, name, direction, kind, body string, at time.Time, truncated bool) {
		t.Helper()
		cipher, err := security.Seal(h.app.Key, body)
		if err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO team_chat_messages(tenant_id,account_id,message_id,customer_id,customer_name,direction,kind,body_cipher,occurred_at,observed_at,truncated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`, tenantID, accountID, id, peer, name, direction, kind, cipher, at, truncated)
	}
	escaped := `<img src=x onerror="window.__teamUnsafe=true"> & <script>window.__teamUnsafe=true</script>`
	for i := 0; i < 55; i++ {
		direction := "out"
		if i%2 == 1 {
			direction = "in"
		}
		body, kind := fmt.Sprintf("fixture-message-%02d · 本团队记录", i), "text"
		if i == 51 {
			body += "\n" + escaped + "\nhttps://example.invalid/" + strings.Repeat("long-path-", 70)
		}
		if i == 52 {
			kind, body = "image", "图片说明：产品资料"
		}
		// The first inbound arrives on the next Beijing day, after our outbound.
		at := start.Add(time.Duration(i) * time.Minute)
		if i > 0 {
			at = at.Add(time.Minute)
		}
		message(tenant, account, fmt.Sprint("preview-main-", i), customer, "林女士", direction, kind, body, at, i == 53)
	}
	message(tenant, account, "preview-outgoing-only", outboundOnly, "尚未回复客户", "out", "text", "仅发送，尚未收到客户消息", start.Add(3*time.Hour), false)
	message(tenant, account, "preview-alias", "lid:123456789", "陈先生", "in", "text", "已合并客户标识", start.Add(4*time.Hour), false)
	message(tenant, secondAccount, "preview-second-device", customer, "林女士", "in", "text", "第二台设备接待记录", start.Add(25*time.Hour), false)
	message(otherTenant, otherAccount, "preview-foreign-secret", otherCustomer, "外部团队保密客户", "in", "text", "外部团队保密聊天正文", start, false)
	exec(`INSERT INTO account_inbound_events(tenant_id,account_id,event_id,customer_id,occurred_at) VALUES($1,$2,'preview-metadata',$3,$4)`, tenant, account, metadataOnly, start.Add(5*time.Hour))
	exec(`INSERT INTO account_customer_aliases(tenant_id,account_id,alias,customer_id) VALUES($1,$2,'lid:123456789',$3)`, tenant, account, aliasCustomer)
	exec(`INSERT INTO customer_conversations(tenant_id,account_id,platform,identifier,duplicate_account,duplicate_ip,baseline_match,history_match) VALUES($1,$2,'whatsapp','lid:123456789',false,false,false,false)`, tenant, account)
	exec(`INSERT INTO customer_profiles(tenant_id,platform,identifier,details) VALUES($1,'whatsapp',$2,'{"name":"仅有资料客户"}'::jsonb)`, tenant, profileOnly)
	exec(`INSERT INTO team_archive_sync(tenant_id,account_id,collector_ready,history_scope,limited) VALUES($1,$2,true,'loaded_only',true)`, tenant, account)
	exec(`INSERT INTO team_archive_sync(tenant_id,account_id,collector_ready,history_scope,limited) VALUES($1,$2,true,'loaded_only',false)`, tenant, secondAccount)
	server := httptest.NewServer(h.r)
	defer server.Close()
	settings := gin.H{
		"apiURL": server.URL, "username": "team-preview-admin", "password": "test-pass-12345",
		"otherUsername": "admin", "otherPassword": "test-password-only-123",
		"accountId": account, "otherAccountId": otherAccount, "secondAccountId": secondAccount,
		"customer": customer, "outboundOnlyCustomer": outboundOnly, "metadataCustomer": metadataOnly,
		"profileCustomer": profileOnly, "aliasCustomer": aliasCustomer, "otherCustomer": otherCustomer,
		"codeId": codeID, "codeLabel": "Alice · 销售一组", "escapedBody": escaped,
		"expectedLeads": []int{4, 4, 29, 28}, "expectedCustomers": []int{6, 4, 29, 29},
		"date": "2026-10-30", "expectedDateLeads": []int{3, 3, 28, 28},
	}
	data, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		t.Fatal(err)
	}
	stop := dest + ".stop"
	if err = os.Remove(stop); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err = os.WriteFile(dest, data, 0600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(dest)
	defer os.Remove(stop)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(15 * time.Minute)
	defer timeout.Stop()
	for {
		select {
		case <-ticker.C:
			if _, err := os.Stat(stop); err == nil {
				return
			}
		case <-timeout.C:
			t.Fatal("team browser fixture timed out after 15 minutes")
		}
	}
}
