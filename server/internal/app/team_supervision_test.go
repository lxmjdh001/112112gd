package app

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type supervisionClient struct{ admin, client, tenant, code, account, device, owner string }

func supervisionFixture(t *testing.T, h *harness, admin, label string, n int) supervisionClient {
	t.Helper()
	code := h.commerceCall(t, "POST", "/login-codes", admin, gin.H{"label": label, "allowedPlatforms": []string{"whatsapp", "line", "telegram"}, "expiresAt": time.Now().Add(time.Hour)})
	status, result := h.login(code["code"].(string), fmt.Sprintf("supervision-%d", n))
	if status != 200 {
		t.Fatal(status, result)
	}
	data := result["data"].(map[string]any)
	client, device := data["accessToken"].(string), data["deviceId"].(string)
	account := h.commerceCall(t, "POST", "/client/accounts", client, gin.H{"label": label + " 账号", "platform": "whatsapp", "proxyId": "", "requestId": key(n)})["id"].(string)
	var tenant string
	if err := h.app.DB.QueryRow(context.Background(), `UPDATE platform_accounts SET device_id=$2,billing_identity='8613800000000' WHERE id=$1 RETURNING tenant_id::text`, account, device).Scan(&tenant); err != nil {
		t.Fatal(err)
	}
	return supervisionClient{admin: admin, client: client, tenant: tenant, code: code["id"].(string), account: account, device: device, owner: "8613800000000"}
}
func supervisionMessage(id, customer, direction, body string, at time.Time) gin.H {
	return gin.H{"id": id, "customer": customer, "direction": direction, "body": body, "kind": "text", "at": at, "observedAt": time.Now().UTC()}
}
func (s supervisionClient) payload(messages ...gin.H) gin.H {
	return gin.H{"owner": s.owner, "ready": true, "historyScope": "loaded_only", "messages": messages}
}
func (s supervisionClient) ingest(t *testing.T, h *harness, messages ...gin.H) map[string]any {
	t.Helper()
	return h.commerceCall(t, "POST", "/client/accounts/"+s.account+"/chat-archive", s.client, s.payload(messages...))
}
func supervisionItems(t *testing.T, h *harness, path, token string) []any {
	t.Helper()
	return h.commerceCall(t, "GET", path, token, nil)["items"].([]any)
}
func supervisionEnable(t *testing.T, h *harness, token string, value bool) {
	t.Helper()
	h.commerceCall(t, "PUT", "/team/settings", token, gin.H{"enabled": value})
}
func supervisionMessagesPath(account, customer string) string {
	return "/team/messages?accountId=" + url.QueryEscape(account) + "&customer=" + url.QueryEscape(customer)
}
func supervisionTime(t *testing.T, value any) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value.(string))
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestTeamSupervisionTenantIsolationAndOptIn(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	member := h.member(t, "team-supervisor-one", "")
	other := h.member(t, "team-supervisor-two", "")
	one := supervisionFixture(t, h, member, "一组业务员", 97001)
	two := supervisionFixture(t, h, other, "二组业务员", 97002)
	initial := h.commerceCall(t, "GET", "/team/settings", member, nil)
	if initial["enabled"] != false {
		t.Fatal(initial)
	}
	plain := "tenant-one-private-text"
	msg := supervisionMessage("first", "447700900001", "in", plain, time.Date(2020, 1, 2, 3, 0, 0, 0, time.UTC))
	disabled := one.ingest(t, h, msg)
	if disabled["enabled"] != false || disabled["accepted"] != float64(0) {
		t.Fatal(disabled)
	}
	var count int
	if err := h.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM team_chat_messages`).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
	supervisionEnable(t, h, member, true)
	if got := h.commerceCall(t, "GET", "/client/team-settings", one.client, nil)["enabled"]; got != true {
		t.Fatal(got)
	}
	for _, token := range []string{h.admin, other} {
		if got := h.commerceCall(t, "GET", "/team/settings", token, nil)["enabled"]; got != false {
			t.Fatal("foreign consent leaked", got)
		}
	}
	one.ingest(t, h, msg)
	supervisionEnable(t, h, other, true)
	two.ingest(t, h, supervisionMessage("second", "447700900002", "in", "tenant-two-secret", time.Now().Add(-time.Hour)))
	for _, path := range []string{"/team/leads", "/team/customers"} {
		own := supervisionItems(t, h, path, member)
		if len(own) != 1 || own[0].(map[string]any)["accountId"] != one.account {
			t.Fatal(path, own)
		}
		if got := supervisionItems(t, h, path+"?tenantId="+one.tenant, h.admin); len(got) != 0 {
			t.Fatal("global operator crossed tenant", got)
		}
	}
	for _, token := range []string{other, h.admin} {
		if status, data := h.call("GET", supervisionMessagesPath(one.account, "447700900001"), token, nil); status != 404 {
			t.Fatal("cross-team transcript", status, data)
		}
	}
	if got := supervisionItems(t, h, "/team/customers?codeId="+one.code, other); len(got) != 0 {
		t.Fatal("foreign code filter leaked", got)
	}
	opts := h.commerceCall(t, "GET", "/team/options", member, nil)["codes"].([]any)
	if len(opts) != 1 || opts[0].(map[string]any)["id"] != one.code {
		t.Fatal(opts)
	}
	var cipher string
	if err := h.app.DB.QueryRow(context.Background(), `SELECT body_cipher FROM team_chat_messages WHERE account_id=$1`, one.account).Scan(&cipher); err != nil || cipher == "" || strings.Contains(cipher, plain) {
		t.Fatal("plaintext at rest", cipher, err)
	}
	archive := h.commerceCall(t, "GET", supervisionMessagesPath(one.account, "447700900001"), member, nil)
	if archive["items"].([]any)[0].(map[string]any)["body"] != plain || archive["historyScope"] != "loaded_only" {
		t.Fatal(archive)
	}
	supervisionEnable(t, h, member, false)
	ignored := one.ingest(t, h, supervisionMessage("ignored", "447700900001", "in", "not-stored-after-optout", time.Now()))
	if ignored["accepted"] != float64(0) || ignored["enabled"] != false {
		t.Fatal(ignored)
	}
	if got := len(supervisionItems(t, h, supervisionMessagesPath(one.account, "447700900001"), member)); got != 1 {
		t.Fatal("optout deleted old history", got)
	}
}

func TestTeamSupervisionArchiveAuthorization(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	admin := h.member(t, "team-auth-owner", "")
	s := supervisionFixture(t, h, admin, "权限业务员", 97101)
	supervisionEnable(t, h, admin, true)
	path := "/client/accounts/" + s.account + "/chat-archive"
	m := supervisionMessage("authorized", "447700900001", "in", "private", time.Now().Add(-time.Minute))
	otherCode := h.commerceCall(t, "POST", "/login-codes", admin, gin.H{"label": "other-code", "allowedPlatforms": []string{"whatsapp"}, "expiresAt": time.Now().Add(time.Hour)})
	status, result := h.login(otherCode["code"].(string), "foreign-code")
	if status != 200 {
		t.Fatal(result)
	}
	otherCodeToken := result["data"].(map[string]any)["accessToken"].(string)
	copied := h.commerceCall(t, "POST", "/login-codes/"+s.code+"/copy", admin, gin.H{})
	status, result = h.login(copied["code"].(string), "foreign-device")
	if status != 200 {
		t.Fatal(result)
	}
	otherDevice := result["data"].(map[string]any)["accessToken"].(string)
	for _, token := range []string{otherCodeToken, otherDevice} {
		if status, data := h.call("POST", path, token, s.payload(m)); status != 404 {
			t.Fatal("foreign account access", status, data)
		}
	}
	for _, owner := range []string{"", "8613800000001"} {
		b := s.payload(m)
		b["owner"] = owner
		if status, data := h.call("POST", path, s.client, b); status != 409 {
			t.Fatal("owner mismatch", status, data)
		}
	}
	ctx := context.Background()
	for _, change := range []string{`paused_at=now()`, `removed_at=now()`, `billing_identity=''`} {
		if _, err := h.app.DB.Exec(ctx, "UPDATE platform_accounts SET "+change+" WHERE id=$1", s.account); err != nil {
			t.Fatal(err)
		}
		expected := 404
		if strings.Contains(change, "billing_identity") {
			expected = 409
		}
		if status, data := h.call("POST", path, s.client, s.payload(m)); status != expected {
			t.Fatal(change, status, data)
		}
		if _, err := h.app.DB.Exec(ctx, `UPDATE platform_accounts SET paused_at=NULL,removed_at=NULL,billing_identity=$2 WHERE id=$1`, s.account, s.owner); err != nil {
			t.Fatal(err)
		}
	}
	var proxy string
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher,enabled) VALUES($1,'disabled','socks5','localhost',1080,'','',false) RETURNING id::text`, s.tenant).Scan(&proxy); err != nil {
		t.Fatal(err)
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE platform_accounts SET proxy_id=$2 WHERE id=$1`, s.account, proxy); err != nil {
		t.Fatal(err)
	}
	if status, data := h.call("POST", path, s.client, s.payload(m)); status != 404 {
		t.Fatal("disabled proxy", status, data)
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE platform_accounts SET proxy_id=NULL WHERE id=$1`, s.account); err != nil {
		t.Fatal(err)
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE login_codes SET allowed_platforms='{}' WHERE id=$1`, s.code); err != nil {
		t.Fatal(err)
	}
	if status, data := h.call("POST", path, s.client, s.payload(m)); status != 404 {
		t.Fatal("revoked platform", status, data)
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE login_codes SET allowed_platforms='{whatsapp}',enabled=false WHERE id=$1`, s.code); err != nil {
		t.Fatal(err)
	}
	if status, _ := h.call("POST", path, s.client, s.payload(m)); status != 401 {
		t.Fatal("disabled code", status)
	}
}

func TestTeamSupervisionHistoryLeadsDedupAndStableProfiles(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	admin := h.member(t, "team-history-owner", "")
	s := supervisionFixture(t, h, admin, "历史业务员", 97201)
	supervisionEnable(t, h, admin, true)
	historical := func(y int) time.Time { return time.Date(y, 1, 2, 8, 0, 0, 0, time.UTC) }
	a, b, c, d := "447700900001", "447700900002", "447700900003", "447700900004"
	messages := []gin.H{supervisionMessage("a-out", a, "out", "hello", historical(2018)), supervisionMessage("a-first", a, "in", "first incoming", historical(2020)), supervisionMessage("a-later", a, "in", "later incoming", historical(2024)), supervisionMessage("b-out", b, "out", "out first", historical(2020)), supervisionMessage("b-in", b, "in", "inbound later", historical(2023)), supervisionMessage("out-only", c, "out", "not a lead", historical(2023))}
	messages[1]["name"] = "History Name"
	first := s.ingest(t, h, messages...)
	retry := s.ingest(t, h, messages...)
	if first["accepted"] != float64(6) || retry["accepted"] != float64(6) {
		t.Fatal(first, retry)
	}
	conflict := supervisionMessage("a-first", b, "in", "wrong customer", historical(2020))
	if status, result := h.call("POST", "/client/accounts/"+s.account+"/chat-archive", s.client, s.payload(conflict)); status != 409 {
		t.Fatal("message id collision must not acknowledge", status, result)
	}
	conflict = supervisionMessage("a-first", a, "out", "wrong direction", historical(2020))
	if status, result := h.call("POST", "/client/accounts/"+s.account+"/chat-archive", s.client, s.payload(conflict)); status != 409 {
		t.Fatal("direction collision must not acknowledge", status, result)
	}
	h.commerceCall(t, "POST", "/client/conversations", s.client, gin.H{"accountId": s.account, "identifier": d})
	h.commerceCall(t, "PUT", "/client/tools/customer", s.client, gin.H{"accountId": s.account, "identifier": a, "details": gin.H{"name": "Preferred Customer Name"}, "language": "en", "version": 0})
	leads := supervisionItems(t, h, "/team/leads", admin)
	if len(leads) != 2 {
		t.Fatal("dedup/outbound/manual lead count", leads)
	}
	for _, raw := range leads {
		row := raw.(map[string]any)
		if row["customer"] == a && (!supervisionTime(t, row["firstAt"]).Equal(historical(2020)) || row["name"] != "Preferred Customer Name") {
			t.Fatal(row)
		}
	}
	if got := supervisionItems(t, h, "/team/customers", admin); len(got) != 4 {
		t.Fatal(got)
	}
	only := supervisionItems(t, h, "/team/leads?startAt=2023-01-02&endAt=2023-01-02", admin)
	if len(only) != 1 || only[0].(map[string]any)["customer"] != b {
		t.Fatal("first incoming date", only)
	}
	overview := h.commerceCall(t, "GET", "/team/overview?scope=leads&startAt=2023-01-02&endAt=2023-01-02", admin, nil)
	if overview["customers"] != float64(1) || overview["newCustomers"] != float64(1) || overview["inbound"] != float64(1) || overview["outbound"] != float64(1) {
		t.Fatal("scoped overview", overview)
	}
	if got := supervisionItems(t, h, "/team/leads?codeId="+s.code+"&search="+url.QueryEscape("Preferred"), admin); len(got) != 1 {
		t.Fatal(got)
	}
	edit := supervisionMessage("a-first", a, "in", "updated body", historical(2025))
	edit["observedAt"] = time.Now().Add(time.Second)
	s.ingest(t, h, edit)
	stale := supervisionMessage("a-first", a, "in", "stale body", historical(2020))
	stale["observedAt"] = time.Now().Add(-time.Hour)
	s.ingest(t, h, stale)
	found := false
	for _, item := range supervisionItems(t, h, supervisionMessagesPath(s.account, a), admin) {
		row := item.(map[string]any)
		if row["body"] == "updated body" {
			found = true
			if !supervisionTime(t, row["at"]).Equal(historical(2020)) {
				t.Fatal("edit changed occurred date", row)
			}
		}
		if row["body"] == "stale body" {
			t.Fatal("stale edit", row)
		}
	}
	if !found {
		t.Fatal("edit lost")
	}
}

func TestTeamSupervisionAliasProfilesAndMetadataOnlyLeads(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	admin := h.member(t, "team-alias-owner", "")
	s := supervisionFixture(t, h, admin, "别名业务员", 97301)
	supervisionEnable(t, h, admin, true)
	lid, phone := "lid:123456789012345", "447700900001"
	profileLID := "123456789012345@lid"
	at := time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	h.commerceCall(t, "POST", "/client/conversations", s.client, gin.H{"accountId": s.account, "identifier": profileLID})
	h.commerceCall(t, "PUT", "/client/tools/customer", s.client, gin.H{"accountId": s.account, "identifier": profileLID, "details": gin.H{"name": "Alias Contact"}, "language": "en", "version": 0})
	if _, err := h.app.DB.Exec(context.Background(), `INSERT INTO account_customer_aliases(tenant_id,account_id,alias,customer_id) VALUES($1,$2,$3,$4)`, s.tenant, s.account, lid, phone); err != nil {
		t.Fatal(err)
	}
	s.ingest(t, h, supervisionMessage("lid-in", lid, "in", "lid body", at), supervisionMessage("phone-out", phone, "out", "phone body", at.Add(time.Hour)))
	customers := supervisionItems(t, h, "/team/customers", admin)
	if len(customers) != 1 || customers[0].(map[string]any)["customer"] != phone || customers[0].(map[string]any)["name"] != "Alias Contact" {
		t.Fatal("alias duplicates", customers)
	}
	if got := supervisionItems(t, h, supervisionMessagesPath(s.account, phone), admin); len(got) != 2 {
		t.Fatal("canonical transcript", got)
	}
	h.commerceCall(t, "POST", "/client/accounts/"+s.account+"/inbound-events", s.client, gin.H{"owner": s.owner, "ready": true, "events": []gin.H{{"id": "metadata-only", "customer": "447700900099", "at": at}}})
	if got := supervisionItems(t, h, "/team/leads", admin); len(got) != 2 {
		t.Fatal("metadata lead lost", got)
	}
	transcript := h.commerceCall(t, "GET", supervisionMessagesPath(s.account, "447700900099"), admin, nil)
	if transcript["total"] != float64(0) {
		t.Fatal("fabricated transcript", transcript)
	}
}

func TestTeamSupervisionMessagePagingKindsAndValidation(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	admin := h.member(t, "team-paging-owner", "")
	s := supervisionFixture(t, h, admin, "分页业务员", 97401)
	supervisionEnable(t, h, admin, true)
	base := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	customer := "447700900001"
	messages := []gin.H{}
	for i := 0; i < 65; i++ {
		direction := "in"
		if i%2 == 1 {
			direction = "out"
		}
		m := supervisionMessage(fmt.Sprintf("page-%02d", i), customer, direction, fmt.Sprintf("message-%02d", i), base.Add(time.Duration(i)*time.Second))
		if i == 0 {
			m["kind"] = "document"
		}
		if i == 1 {
			m["truncated"] = true
		}
		messages = append(messages, m)
	}
	payload := s.payload(messages...)
	payload["limited"] = true
	h.commerceCall(t, "POST", "/client/accounts/"+s.account+"/chat-archive", s.client, payload)
	path := supervisionMessagesPath(s.account, customer)
	first := h.commerceCall(t, "GET", path, admin, nil)
	rows := first["items"].([]any)
	if first["total"] != float64(65) || len(rows) != 50 || rows[0].(map[string]any)["body"] != "message-64" || rows[49].(map[string]any)["body"] != "message-15" || first["limited"] != true {
		t.Fatal(first)
	}
	second := h.commerceCall(t, "GET", path+"&page=2", admin, nil)
	rows = second["items"].([]any)
	if len(rows) != 15 || rows[14].(map[string]any)["kind"] != "document" || rows[13].(map[string]any)["truncated"] != true {
		t.Fatal(second)
	}
	unready := s.payload()
	unready["ready"] = false
	unready["historyScope"] = "unavailable"
	h.commerceCall(t, "POST", "/client/accounts/"+s.account+"/chat-archive", s.client, unready)
	metadata := h.commerceCall(t, "GET", path, admin, nil)
	if metadata["historyScope"] != "unavailable" || metadata["collectorReady"] != false || metadata["total"] != float64(65) {
		t.Fatal(metadata)
	}
	for _, bad := range []gin.H{{"owner": s.owner, "ready": false, "historyScope": "loaded_only", "messages": messages[:1]}, {"owner": s.owner, "ready": true, "historyScope": "full", "messages": messages[:1]}, s.payload(supervisionMessage("self", s.owner, "in", "self", base)), s.payload(supervisionMessage("invalid", "not-an-identity", "in", "invalid", base)), s.payload(supervisionMessage("huge", customer, "in", strings.Repeat("字", 8001), base))} {
		if status, data := h.call("POST", "/client/accounts/"+s.account+"/chat-archive", s.client, bad); status != 400 {
			t.Fatal("invalid record", status, data)
		}
	}
	for _, query := range []string{"/team/leads?startAt=not-a-date", "/team/customers?platform=facebook", "/team/overview?startAt=2020-01-03&endAt=2020-01-01"} {
		if status, data := h.call("GET", query, admin, nil); status != 400 {
			t.Fatal(query, status, data)
		}
	}
}

func TestTeamSupervisionCloudRetainedHistory(t *testing.T) {
	h := setupCloud(t)
	number := h.number(t, "200001")
	customer := "15550001111"
	h.receive(t, number, "200001", "wamid.supervision-history", customer, time.Now().Add(-time.Hour))
	archive := h.commerceCall(t, "GET", supervisionMessagesPath(number, customer), h.admin, nil)
	if archive["historyScope"] != "cloud_retained" || archive["collectorReady"] != true || archive["total"] != float64(1) {
		t.Fatal(archive)
	}
	leads := supervisionItems(t, h.harness, "/team/leads", h.admin)
	if len(leads) != 1 || leads[0].(map[string]any)["accountId"] != number || leads[0].(map[string]any)["customer"] != customer {
		t.Fatal(leads)
	}
	other := h.member(t, "cloud-foreign-team", "")
	if status, data := h.call("GET", supervisionMessagesPath(number, customer), other, nil); status != 404 {
		t.Fatal("cloud cross tenant", status, data)
	}
}
