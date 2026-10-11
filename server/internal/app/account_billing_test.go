package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestRegistrationPointGift(t *testing.T) {
	h := setup(t)
	member := h.member(t, "point-customer", "")
	got := h.commerceCall(t, "GET", "/account/billing", member, nil)
	if got["points"] != "100" {
		t.Fatal("new company gift missing", got)
	}
	if s, _ := h.call("POST", "/auth/register", "", gin.H{"username": "point-customer", "password": "test-password-12345", "teamName": "duplicate"}); s != 409 {
		t.Fatal("duplicate registration", s)
	}
	got = h.commerceCall(t, "GET", "/account/billing", member, nil)
	if got["points"] != "100" {
		t.Fatal("gift repeated", got)
	}
}

func TestAccountDaysConcurrentIdentityAndBeijingBoundary(t *testing.T) {
	h := setup(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 11, 15, 59, 59, 0, time.UTC)
	h.app.BillingNow = func() time.Time { return now }
	token, account := toolsClient(t, h, "billing-one")
	token2, account2 := toolsClient(t, h, "billing-two")
	if _, e := h.app.DB.Exec(ctx, `UPDATE wallets SET available_cents=1000 WHERE kind='balance'`); e != nil {
		t.Fatal(e)
	}
	for _, status := range []string{"qr_required", "loading", "unknown", "closed"} {
		h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", token, gin.H{"status": status})
	}
	if got := h.commerceCall(t, "GET", "/account/billing", h.admin, nil); got["todayAccounts"] != float64(0) {
		t.Fatal("waiting for QR charged", got)
	}
	var wg sync.WaitGroup
	results := make(chan int, 16)
	for i := range 16 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tok, id := token, account
			if i%2 == 1 {
				tok, id = token2, account2
			}
			s, _ := h.call("POST", "/client/accounts/"+id+"/status", tok, gin.H{"status": "ready", "identifier": "15550000001"})
			results <- s
		}(i)
	}
	wg.Wait()
	close(results)
	for s := range results {
		if s != 200 {
			t.Fatal("concurrent status failed", s)
		}
	}
	got := h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["points"] != "9" || got["todayAccounts"] != float64(1) {
		t.Fatal("same platform account double charged", got)
	}
	now = now.Add(time.Second)
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", token, gin.H{"status": "ready", "identifier": "15550000001"})
	got = h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["points"] != "8" || got["billingDay"] != "2026-10-12" {
		t.Fatal("Beijing boundary", got)
	}
	// A different logged-in platform identity in the same slot is independently billed.
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", token, gin.H{"status": "ready", "identifier": "15550000002"})
	got = h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["points"] != "7" {
		t.Fatal("new identity not charged", got)
	}
	if s, _ := h.call("POST", "/client/accounts/"+account+"/status", token2, gin.H{"status": "ready", "identifier": "15550000003"}); s != 404 {
		t.Fatal("foreign slot billable", s)
	}
}

func TestCompanyGraceLifetimeAndForcedLogout(t *testing.T) {
	h := setup(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 11, 8, 0, 0, 0, time.UTC)
	h.app.BillingNow = func() time.Time { return now }
	token, account := toolsClient(t, h, "grace-one")
	token2, account2 := toolsClient(t, h, "grace-two")
	online := func(token, account, phone string) {
		h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", token, gin.H{"status": "ready", "identifier": phone})
	}
	online(token, account, "15550000001")
	online(token2, account2, "15550000002")
	got := h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["graceDaysUsed"] != float64(1) || got["todayAccounts"] != float64(2) {
		t.Fatal("grace must be company-wide", got)
	}
	now = now.AddDate(0, 0, 10)
	h.commerceCall(t, "POST", "/client/heartbeat", token, gin.H{})
	got = h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["graceDaysUsed"] != float64(1) {
		t.Fatal("idle days consumed grace", got)
	}
	online(token, account, "15550000001")
	if _, e := h.app.DB.Exec(ctx, `UPDATE wallets SET available_cents=200 WHERE kind='balance'`); e != nil {
		t.Fatal(e)
	}
	now = now.AddDate(0, 0, 1)
	online(token, account, "15550000001")
	got = h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["graceDaysUsed"] != float64(2) || got["points"] != "1" {
		t.Fatal("recharge reset lifetime grace", got)
	}
	now = now.AddDate(0, 0, 1)
	online(token, account, "15550000001")
	online(token2, account2, "15550000002")
	got = h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["graceDaysUsed"] != float64(3) {
		t.Fatal("third grace day missing", got)
	}
	now = now.AddDate(0, 0, 1)
	if s, _ := h.call("POST", "/client/heartbeat", token, gin.H{}); s != 402 {
		t.Fatal("overdue session stayed live", s)
	}
	if s, _ := h.call("POST", "/client/heartbeat", token2, gin.H{}); s != 402 {
		t.Fatal("other company session not revoked", s)
	}
	if _, e := h.app.DB.Exec(ctx, `UPDATE wallets SET available_cents=100 WHERE kind='balance'`); e != nil {
		t.Fatal(e)
	}
	if s, _ := h.call("POST", "/client/heartbeat", token, gin.H{}); s != 402 {
		t.Fatal("old session revived after recharge", s)
	}
	got = h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["graceDaysRemaining"] != float64(0) {
		t.Fatal("grace reset", got)
	}
}

func TestCloudAndNativeShareWhatsAppDailyIdentity(t *testing.T) {
	h := setupCloud(t)
	ctx := context.Background()
	n := h.number(t, "200001")
	token, account := toolsClient(t, h.harness, "same-wa-phone")
	if _, e := h.app.DB.Exec(ctx, `UPDATE wallets SET available_cents=500 WHERE kind='balance'`); e != nil {
		t.Fatal(e)
	}
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", token, gin.H{"status": "ready", "identifier": "15550000001"})
	h.commerceCall(t, "GET", "/whatsapp-cloud/numbers/"+n+"/chats", h.admin, nil)
	got := h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["points"] != "4" || got["todayAccounts"] != float64(1) {
		t.Fatal("API and native duplicated charge", got)
	}
}

func TestBillingReplacementIsolationAndPlatformScope(t *testing.T) {
	h := setup(t)
	ctx := context.Background()
	token, account := toolsClient(t, h, "replace-original")
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", token, gin.H{"status": "ready", "identifier": "15550000001"})
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/close", token, gin.H{})
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/remove", token, gin.H{})
	replacement := h.commerceCall(t, "POST", "/client/accounts", token, gin.H{"label": "replacement", "platform": "whatsapp", "requestId": key(1401)})["id"].(string)
	h.commerceCall(t, "POST", "/client/accounts/"+replacement+"/status", token, gin.H{"status": "ready", "identifier": "15550000001"})
	got := h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["todayAccounts"] != float64(1) {
		t.Fatal("removed identity charged again", got)
	}
	// Same string on a different platform is a different account.
	var tenant string
	if e := h.app.DB.QueryRow(ctx, `SELECT tenant_id::text FROM platform_accounts WHERE id=$1`, replacement).Scan(&tenant); e != nil {
		t.Fatal(e)
	}
	tx, e := h.app.DB.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if e = chargeAccountDay(ctx, tx, tenant, replacement, "line", "15550000001", h.app.billingTime()); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	got = h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["todayAccounts"] != float64(2) {
		t.Fatal("platforms incorrectly merged", got)
	}
	member := h.member(t, "billing-other-company", "")
	otherCode := h.commerceCall(t, "POST", "/login-codes", member, gin.H{"label": "other", "allowedPlatforms": []string{"whatsapp"}, "expiresAt": time.Now().Add(time.Hour)})
	_, login := h.login(otherCode["code"].(string), "other-company")
	otherToken := login["data"].(map[string]any)["accessToken"].(string)
	other := h.commerceCall(t, "POST", "/client/accounts", otherToken, gin.H{"label": "other", "platform": "whatsapp", "requestId": key(1402)})["id"].(string)
	h.commerceCall(t, "POST", "/client/accounts/"+other+"/status", otherToken, gin.H{"status": "ready", "identifier": "15550000001"})
	got = h.commerceCall(t, "GET", "/account/billing", member, nil)
	if got["points"] != "99" || got["todayAccounts"] != float64(1) {
		t.Fatal("company balance or identity shared", got)
	}
	history := h.commerceCall(t, "GET", "/account/billing/days", member, nil)
	if history["total"] != float64(1) {
		t.Fatal("foreign history exposed", history)
	}
}

func TestBillingRechargeRequiresFreshClientLogin(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 11, 8, 0, 0, 0, time.UTC)
	h.app.BillingNow = func() time.Time { return now }
	_, raw := h.code(t)
	_, login := h.login(raw, "renew-device")
	token := login["data"].(map[string]any)["accessToken"].(string)
	account := h.commerceCall(t, "POST", "/client/accounts", token, gin.H{"label": "renew", "platform": "whatsapp", "requestId": key(1420)})["id"].(string)
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", token, gin.H{"status": "ready", "identifier": "15550000001"})
	if _, e := h.app.DB.Exec(ctx, `UPDATE account_billing_state SET grace_days_used=3,covered_day=$1::date`, billingDay(now.AddDate(0, 0, -1))); e != nil {
		t.Fatal(e)
	}
	if s, _ := h.call("POST", "/client/heartbeat", token, gin.H{}); s != 402 {
		t.Fatal("did not revoke", s)
	}
	if s, _ := h.login(raw, "renew-device"); s != 402 {
		t.Fatal("expired company could log in", s)
	}
	order := h.topup(t, h.admin, "1.00", 1421)
	h.credit(t, order, 1421)
	if s, _ := h.call("POST", "/client/heartbeat", token, gin.H{}); s != 402 {
		t.Fatal("revoked token restored", s)
	}
	s, login := h.login(raw, "renew-device")
	if s != 200 {
		t.Fatal("recharged login blocked", s, login)
	}
	fresh := login["data"].(map[string]any)["accessToken"].(string)
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/open", fresh, gin.H{})
	now = now.AddDate(0, 0, 1)
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", fresh, gin.H{"status": "ready", "identifier": "15550000001"})
	h.commerceCall(t, "POST", "/client/heartbeat", fresh, gin.H{})
	if s, _ := h.call("POST", "/client/accounts/"+account+"/status", fresh, gin.H{"status": "ready", "identifier": "15550000002"}); s != 409 {
		t.Fatal("new account bypassed exhausted grace", s)
	}
	got := h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["points"] != "0" || got["graceDaysUsed"] != float64(3) {
		t.Fatal("recharge accounting", got)
	}
	now = now.AddDate(0, 0, 1)
	if s, _ := h.call("POST", "/client/heartbeat", fresh, gin.H{}); s != 402 {
		t.Fatal("last paid day ran forever", s)
	}
}

func TestDisabledCloudHistoryDoesNotConsumePoints(t *testing.T) {
	h := setupCloud(t)
	n := h.number(t, "200001")
	if _, e := h.app.DB.Exec(context.Background(), `UPDATE wa_cloud_numbers SET enabled=false WHERE id=$1`, n); e != nil {
		t.Fatal(e)
	}
	h.commerceCall(t, "GET", "/whatsapp-cloud/numbers/"+n+"/chats", h.admin, nil)
	got := h.commerceCall(t, "GET", "/account/billing", h.admin, nil)
	if got["todayAccounts"] != float64(0) || got["graceDaysUsed"] != float64(0) {
		t.Fatal("inactive history charged", got)
	}
}

func TestWholePointAmounts(t *testing.T) {
	for _, input := range []string{"1", "100", "100.00"} {
		n, e := parsePointAmount(input)
		if e != nil || n%100 != 0 {
			t.Fatal(input, n, e)
		}
	}
	for _, input := range []string{"0.01", "1.50", "2.99"} {
		if _, e := parsePointAmount(input); e == nil {
			t.Fatal("fraction accepted", input)
		}
	}
	for value, want := range map[int64]string{0: "0", 100: "1", 10000: "100", -100: "-1"} {
		if got := pointText(value); got != want {
			t.Fatal("decimal point display", got)
		}
	}
	h := setup(t)
	h.commerceConfig(t)
	if s, _ := h.call("POST", "/account/recharges", h.admin, gin.H{"amount": "1.50", "requestId": key(1901), "paymentReference": "whole-points"}); s != 400 {
		t.Fatal("fractional recharge", s)
	}
	if s, _ := h.call("POST", "/promotion/transfers", h.admin, gin.H{"amount": "1.50", "requestId": key(1902)}); s != 400 {
		t.Fatal("fractional transfer", s)
	}
}
