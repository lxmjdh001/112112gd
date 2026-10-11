package app

import (
	"context"
	"fmt"
	"github.com/gin-gonic/gin"
	"strings"
	"sync"
	"testing"
)

func (h *harness) commerceConfig(t *testing.T) gin.H {
	t.Helper()
	b := gin.H{"currency": "CNY", "paymentInstructions": "test receipt only", "payoutChannel": "test transfer", "rechargeEnabled": true, "withdrawalEnabled": true, "registrationEnabled": true, "commissionBps": 1000, "minRecharge": "1.00", "minWithdrawal": "1.00"}
	if s, d := h.call("PUT", "/operations/settings", h.admin, b); s != 200 {
		t.Fatal(s, d)
	}
	return b
}
func (h *harness) commerceCall(t *testing.T, method, path, token string, body any) map[string]any {
	t.Helper()
	s, d := h.call(method, path, token, body)
	if s != 200 {
		t.Fatalf("%s %s: %d %v", method, path, s, d)
	}
	if v, ok := d["data"].(map[string]any); ok {
		return v
	}
	return d
}
func (h *harness) member(t *testing.T, name, ref string) string {
	t.Helper()
	h.commerceCall(t, "POST", "/auth/register", "", gin.H{"username": name, "password": "test-password-12345", "teamName": name, "referralCode": ref, "platform_operator": true})
	return h.commerceCall(t, "POST", "/auth/login", "", gin.H{"username": name, "password": "test-password-12345"})["accessToken"].(string)
}
func key(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }
func (h *harness) topup(t *testing.T, token, amount string, n int) string {
	t.Helper()
	return h.commerceCall(t, "POST", "/account/recharges", token, gin.H{"amount": amount, "requestId": key(n), "paymentReference": fmt.Sprint("payment-", n)})["id"].(string)
}
func (h *harness) credit(t *testing.T, id string, n int) {
	t.Helper()
	h.commerceCall(t, "POST", "/operations/recharges/"+id+"/review", h.admin, gin.H{"action": "credit", "receiptReference": fmt.Sprint("receipt-", n)})
}
func TestCommerceDisabledByDefaultAndMoneyParsing(t *testing.T) {
	h := setup(t)
	if _, e := h.app.DB.Exec(context.Background(), `UPDATE commerce_settings SET registration_enabled=false`); e != nil {
		t.Fatal(e)
	}
	if s, _ := h.call("POST", "/auth/register", "", gin.H{"username": "member", "password": "test-password-12345", "teamName": "test"}); s != 403 {
		t.Fatal("registration must be explicitly enabled", s)
	}
	if s, _ := h.call("POST", "/account/recharges", h.admin, gin.H{"amount": "10.00", "requestId": key(1), "paymentReference": "test"}); s != 409 {
		t.Fatal("unconfigured recharge accepted", s)
	}
	for _, amount := range []string{"0", "-1", "NaN", "1e2", "0.001", "1000000.01", "1.239", " 1.00", "1,000"} {
		if _, e := parseMoney(amount); e == nil {
			t.Fatal("invalid money", amount)
		}
	}
	for value, want := range map[string]int64{"1": 100, "0.01": 1, "12.30": 1230, "1000000.00": 100000000} {
		got, e := parseMoney(value)
		if e != nil || got != want {
			t.Fatal(value, got, e)
		}
	}
}
func TestCommerceCreditCommissionWithdrawalAndLedger(t *testing.T) {
	h := setup(t)
	config := h.commerceConfig(t)
	promo := h.commerceCall(t, "GET", "/promotion", h.admin, nil)
	member := h.member(t, "referred-member", promo["code"].(string))
	if h.commerceCall(t, "GET", "/account/profile", member, nil)["isOperator"] != false {
		t.Fatal("registration escalated privileges")
	}
	for _, path := range []string{"/operations/settings", "/operations/recharges", "/operations/withdrawals"} {
		if s, _ := h.call("GET", path, member, nil); s != 403 {
			t.Fatal("member accessed operations", s)
		}
	}
	order := h.topup(t, member, "100.00", 1)
	if retry := h.topup(t, member, "100.00", 1); retry != order {
		t.Fatal("retry duplicated recharge")
	}
	var wg sync.WaitGroup
	statuses := make(chan int, 6)
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, _ := h.call("POST", "/operations/recharges/"+order+"/review", h.admin, gin.H{"action": "credit", "receiptReference": "receipt-1"})
			statuses <- s
		}()
	}
	wg.Wait()
	close(statuses)
	for s := range statuses {
		if s != 200 {
			t.Fatal("credit retry failed", s)
		}
	}
	if b := h.commerceCall(t, "GET", "/account/summary", member, nil)["balance"]; b != "200.00" {
		t.Fatal("credit repeated", b)
	}
	if b := h.commerceCall(t, "GET", "/promotion", h.admin, nil)["available"]; b != "10.00" {
		t.Fatal("commission incorrect", b)
	}
	config["currency"] = "USD"
	if s, _ := h.call("PUT", "/operations/settings", h.admin, config); s != 409 {
		t.Fatal("currency changed after orders", s)
	}
	other := h.member(t, "isolated-member", "")
	if items := h.commerceCall(t, "GET", "/account/recharges", other, nil)["items"].([]any); len(items) != 0 {
		t.Fatal("cross-tenant recharge leak")
	}
	if s, _ := h.call("POST", "/account/recharges/"+order+"/cancel", other, gin.H{}); s != 404 {
		t.Fatal("cross-tenant cancel", s)
	}
	second := h.topup(t, member, "20.00", 2)
	if s, _ := h.call("POST", "/operations/recharges/"+second+"/review", h.admin, gin.H{"action": "credit", "receiptReference": "receipt-1"}); s != 409 {
		t.Fatal("receipt reused", s)
	}
	if b := h.commerceCall(t, "GET", "/account/summary", member, nil)["balance"]; b != "200.00" {
		t.Fatal("failed receipt partially committed", b)
	}
	h.commerceCall(t, "POST", "/promotion/transfers", h.admin, gin.H{"amount": "3.00", "requestId": key(3)})
	h.commerceCall(t, "POST", "/promotion/transfers", h.admin, gin.H{"amount": "3.00", "requestId": key(3)})
	if b := h.commerceCall(t, "GET", "/account/summary", h.admin, nil)["balance"]; b != "3.00" {
		t.Fatal("transfer retry duplicated", b)
	}
	withdrawal := h.commerceCall(t, "POST", "/promotion/withdrawals", h.admin, gin.H{"amount": "5.00", "requestId": key(4), "destination": "test-private-account-123456"})["id"].(string)
	if s, _ := h.call("POST", "/promotion/transfers", h.admin, gin.H{"amount": "3.00", "requestId": key(5)}); s != 409 {
		t.Fatal("frozen funds spent", s)
	}
	if s, _ := h.call("POST", "/operations/withdrawals/"+withdrawal+"/review", member, gin.H{"action": "pay", "payoutReference": "fake"}); s != 403 {
		t.Fatal("member may not mark paid", s)
	}
	rows := h.commerceCall(t, "GET", "/promotion/withdrawals", h.admin, nil)["items"].([]any)
	if strings.Contains(fmt.Sprint(rows), "test-private-account") {
		t.Fatal("unmasked destination leaked")
	}
	if got := h.commerceCall(t, "POST", "/operations/withdrawals/"+withdrawal+"/destination", h.admin, gin.H{})["destination"]; got != "test-private-account-123456" {
		t.Fatal("encrypted destination roundtrip", got)
	}
	h.commerceCall(t, "POST", "/promotion/withdrawals/"+withdrawal+"/cancel", h.admin, gin.H{})
	h.commerceCall(t, "POST", "/promotion/withdrawals/"+withdrawal+"/cancel", h.admin, gin.H{})
	if b := h.commerceCall(t, "GET", "/promotion", h.admin, nil)["available"]; b != "7.00" {
		t.Fatal("cancellation balance incorrect", b)
	}
	withdrawal = h.commerceCall(t, "POST", "/promotion/withdrawals", h.admin, gin.H{"amount": "4.00", "requestId": key(6), "destination": "test-private-account-123456"})["id"].(string)
	h.commerceCall(t, "POST", "/operations/withdrawals/"+withdrawal+"/review", h.admin, gin.H{"action": "approve"})
	if s, _ := h.call("POST", "/promotion/withdrawals/"+withdrawal+"/cancel", h.admin, gin.H{}); s != 409 {
		t.Fatal("approved withdrawal cancelled", s)
	}
	h.commerceCall(t, "POST", "/operations/withdrawals/"+withdrawal+"/review", h.admin, gin.H{"action": "pay", "payoutReference": "payout-1"})
	h.commerceCall(t, "POST", "/operations/withdrawals/"+withdrawal+"/review", h.admin, gin.H{"action": "pay", "payoutReference": "payout-1"})
	p := h.commerceCall(t, "GET", "/promotion", h.admin, nil)
	if p["available"] != "3.00" || p["held"] != "0.00" || p["paid"] != "4.00" {
		t.Fatal("settlement incorrect", p)
	}
	if s, _ := h.call("POST", "/operations/recharges/"+order+"/review", h.admin, gin.H{"action": "refund", "note": "test refund", "refundReference": "refund-1"}); s != 409 {
		t.Fatal("spent commission should prevent partial refund", s)
	}
	if b := h.commerceCall(t, "GET", "/account/summary", member, nil)["balance"]; b != "200.00" {
		t.Fatal("failed refund partially debited", b)
	}
	h.credit(t, second, 2)
	h.commerceCall(t, "POST", "/operations/recharges/"+second+"/review", h.admin, gin.H{"action": "refund", "note": "test refund", "refundReference": "refund-2"})
	h.commerceCall(t, "POST", "/operations/recharges/"+second+"/review", h.admin, gin.H{"action": "refund", "note": "test refund", "refundReference": "refund-2"})
	if b := h.commerceCall(t, "GET", "/promotion", h.admin, nil)["available"]; b != "3.00" {
		t.Fatal("refund duplicated or incorrect", b)
	}
	for _, route := range []string{"/account/ledger", "/account/ledger?kind=commission", "/account/purchases", "/account/usage", "/promotion/referrals", "/promotion/commissions", "/operations/recharges", "/operations/withdrawals"} {
		h.commerceCall(t, "GET", route, h.admin, nil)
	}
	var bad int
	e := h.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM wallets w WHERE w.available_cents<>COALESCE((SELECT sum(available_delta) FROM wallet_entries e WHERE e.tenant_id=w.tenant_id AND e.kind=w.kind),0) OR w.held_cents<>COALESCE((SELECT sum(held_delta) FROM wallet_entries e WHERE e.tenant_id=w.tenant_id AND e.kind=w.kind),0)`).Scan(&bad)
	if e != nil || bad != 0 {
		t.Fatal("ledger does not reconcile", bad, e)
	}
}
func TestConcurrentCommissionSpendAndProfileSecurity(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	code := h.commerceCall(t, "GET", "/promotion", h.admin, nil)["code"].(string)
	token := h.member(t, "concurrency-member", code)
	order := h.topup(t, token, "100.00", 1)
	h.credit(t, order, 1)
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i := range 2 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s, _ := h.call("POST", "/promotion/transfers", h.admin, gin.H{"amount": "8.00", "requestId": key(i + 20)})
			statuses <- s
		}(i)
	}
	wg.Wait()
	close(statuses)
	success := 0
	for s := range statuses {
		if s == 200 {
			success++
		} else if s != 409 {
			t.Fatal("unexpected spend result", s)
		}
	}
	if success != 1 {
		t.Fatal("concurrent overspend", success)
	}
	h.commerceCall(t, "PATCH", "/account/profile", token, gin.H{"displayName": "客户名称", "teamName": "客户团队", "contact": "support@example.test", "isOperator": true})
	if info := h.commerceCall(t, "GET", "/account/profile", token, nil); info["isOperator"] != false || info["teamName"] != "客户团队" {
		t.Fatal("profile update permissions", info)
	}
	second := h.commerceCall(t, "POST", "/auth/login", "", gin.H{"username": "concurrency-member", "password": "test-password-12345"})["accessToken"].(string)
	if s, _ := h.call("POST", "/account/password", token, gin.H{"currentPassword": "incorrect", "newPassword": "new-test-password-123"}); s != 400 {
		t.Fatal("password changed without original", s)
	}
	h.commerceCall(t, "POST", "/account/password", token, gin.H{"currentPassword": "test-password-12345", "newPassword": "new-test-password-123"})
	if s, _ := h.call("GET", "/account/profile", second, nil); s != 401 {
		t.Fatal("other session not revoked", s)
	}
	h.commerceCall(t, "GET", "/account/profile", token, nil)
	if s, _ := h.call("POST", "/auth/login", "", gin.H{"username": "concurrency-member", "password": "test-password-12345"}); s != 401 {
		t.Fatal("old password still accepted", s)
	}
	h.commerceCall(t, "POST", "/auth/login", "", gin.H{"username": "concurrency-member", "password": "new-test-password-123"})
	h.commerceCall(t, "PATCH", "/promotion", h.admin, gin.H{"enabled": false})
	if s, _ := h.call("POST", "/auth/register", "", gin.H{"username": "blocked-referral", "password": "test-password-12345", "teamName": "blocked", "referralCode": code}); s != 400 {
		t.Fatal("disabled referral accepted", s)
	}
}

func TestUsageMetadataOwnershipAndIdempotency(t *testing.T) {
	h := setup(t)
	_, raw := h.code(t)
	s, b := h.login(raw, "usage-device")
	if s != 200 {
		t.Fatal(b)
	}
	client := b["data"].(map[string]any)["accessToken"].(string)
	h.commerceCall(t, "POST", "/proxies/import", h.admin, gin.H{"lines": "usage:1080"})
	proxy := h.proxyRow(t, "usage")["id"].(string)
	account := h.commerceCall(t, "POST", "/client/accounts", client, gin.H{"label": "usage account", "platform": "whatsapp", "proxyId": proxy, "requestId": key(31)})["id"].(string)
	body := gin.H{"accountId": account, "requestId": key(32), "provider": "google-free", "inputChars": 5, "outputChars": 2, "targetLanguage": "zh-CN", "text": "must-not-be-stored"}
	h.commerceCall(t, "POST", "/client/usage", client, body)
	h.commerceCall(t, "POST", "/client/usage", client, body)
	data := h.commerceCall(t, "GET", "/account/usage", h.admin, nil)
	if data["total"] != float64(1) || strings.Contains(fmt.Sprint(data), "must-not-be-stored") {
		t.Fatal("usage duplicate or content leak", data)
	}
	summary := h.commerceCall(t, "GET", "/account/summary", h.admin, nil)
	if summary["translationChars"] != float64(5) || summary["balance"] != "0.00" {
		t.Fatal("free usage changed wallet", summary)
	}
	body["inputChars"] = 6
	if s, _ = h.call("POST", "/client/usage", client, body); s != 409 {
		t.Fatal("usage request reused with other payload", s)
	}
	_, other := h.code(t)
	s, b = h.login(other, "other-usage-device")
	if s != 200 {
		t.Fatal(b)
	}
	otherClient := b["data"].(map[string]any)["accessToken"].(string)
	body["requestId"] = key(33)
	if s, _ = h.call("POST", "/client/usage", otherClient, body); s != 404 {
		t.Fatal("another code reports usage", s)
	}
	if s, _ = h.call("GET", "/account/summary", client, nil); s != 401 {
		t.Fatal("client accessed wallet", s)
	}
}
func TestConcurrentCreditTransferAndWithdrawal(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	code := h.commerceCall(t, "GET", "/promotion", h.admin, nil)["code"].(string)
	member := h.member(t, "mixed-spend-member", code)
	first := h.topup(t, member, "100.00", 1)
	h.credit(t, first, 1)
	second := h.topup(t, member, "100.00", 2)
	start := make(chan struct{})
	statuses := make(chan int, 7)
	var wg sync.WaitGroup
	for i := range 7 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			var s int
			if i == 6 {
				s, _ = h.call("POST", "/operations/recharges/"+second+"/review", h.admin, gin.H{"action": "credit", "receiptReference": "mixed-receipt"})
			} else if i%2 == 0 {
				s, _ = h.call("POST", "/promotion/transfers", h.admin, gin.H{"requestId": key(i + 40), "amount": "3.00"})
			} else {
				s, _ = h.call("POST", "/promotion/withdrawals", h.admin, gin.H{"requestId": key(i + 40), "amount": "3.00", "destination": "test-destination"})
			}
			statuses <- s
		}(i)
	}
	close(start)
	wg.Wait()
	close(statuses)
	for s := range statuses {
		if s != 200 && s != 409 {
			t.Fatal("deadlock or unexpected spend result", s)
		}
	}
	var correct bool
	e := h.app.DB.QueryRow(context.Background(), `SELECT w.available_cents+w.held_cents+COALESCE((SELECT sum(amount_cents) FROM commission_transfers WHERE tenant_id=w.tenant_id),0)=2000 FROM wallets w WHERE kind='commission'`).Scan(&correct)
	if e != nil || !correct {
		t.Fatal("money lost under concurrent operations", e)
	}
}
