package app

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWorkOrderGo7JSON(t *testing.T) {
	h := setup(t)
	f := publicWorkOrderClient(t, h)
	account := f.account(t, "go7", "whatsapp", "8613800000001", time.Now())
	id := h.commerceCall(t, "POST", "/work-orders", h.admin, gin.H{"name": "go7 export", "accountIds": []string{account}, "startAt": time.Now().Add(-time.Hour), "enabled": true})["id"].(string)
	token := publicWorkOrderToken(t, h, id)
	endpoint := "/public/work-orders/" + token + "?api=go7"
	data := h.commerceCall(t, "GET", endpoint, "", nil)
	if data["total"] != float64(1) {
		t.Fatal(data)
	}
	row := data["accounts"].([]any)[0].(map[string]any)
	if row["id"] != account || row["account"] != "8613800000001" {
		t.Fatal(row)
	}
	h.commerceCall(t, "PUT", "/work-orders/"+id, h.admin, gin.H{"name": "go7 export", "accountIds": []string{account}, "startAt": time.Now().Add(-time.Hour), "enabled": true, "password": "secret"})
	if status, _ := h.call("GET", endpoint, "", nil); status != 403 {
		t.Fatal(status)
	}
	req := httptest.NewRequest("GET", "/api/v1"+endpoint, nil)
	req.Header.Set("X-Work-Order-Password", "secret")
	response := httptest.NewRecorder()
	h.r.ServeHTTP(response, req)
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(response.Code, response.Body.String())
	}
	replacement := h.commerceCall(t, "POST", "/work-orders/"+id+"/rotate", h.admin, gin.H{})["token"].(string)
	if status, _ := h.call("GET", endpoint, "", nil); status != 404 {
		t.Fatal(status)
	}
	if status, _ := h.call("GET", "/public/work-orders/"+replacement+"?api=go7", "", nil); status != 403 {
		t.Fatal(status)
	}
}

func TestWorkOrderGo7ScopeCountsAndLegacyCompatibility(t *testing.T) {
	h := setup(t)
	f := publicWorkOrderClient(t, h)
	ctx := context.Background()
	now := time.Now()
	first := f.account(t, "API display one", "whatsapp", "8613800000001", now)
	second := f.account(t, "Removed account", "whatsapp", "8613800000002", now)
	f.account(t, "PRIVATE-UNSELECTED", "whatsapp", "8613999999999", now)
	order := h.commerceCall(t, "POST", "/work-orders", h.admin, gin.H{"name": "go7 scope", "accountIds": []string{first, second}, "startAt": now.Add(-time.Hour), "enabled": true})["id"].(string)
	for i, event := range []struct{ account, customer string }{{first, "447700900001"}, {first, "447700900002"}, {second, "447700900001"}} {
		if _, err := h.app.DB.Exec(ctx, `INSERT INTO account_inbound_events(tenant_id,account_id,event_id,customer_id,occurred_at) VALUES($1,$2,$3,$4,$5)`, f.tenant, event.account, fmt.Sprint("go7-", i), event.customer, now.Add(time.Duration(i-10)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE platform_accounts SET removed_at=now() WHERE id=$1`, second); err != nil {
		t.Fatal(err)
	}
	token := publicWorkOrderToken(t, h, order)
	endpoint := "/public/work-orders/" + token
	legacy := h.commerceCall(t, "POST", endpoint, "", gin.H{})
	if legacy["total"] != float64(3) {
		t.Fatal("legacy total no longer counts inbound contacts", legacy)
	}
	for _, path := range []string{endpoint + "?api=go7", endpoint + "/accounts"} {
		data := h.commerceCall(t, "GET", path, "", nil)
		if data["total"] != float64(2) {
			t.Fatal("export total must count selected accounts", data)
		}
		exported, _ := json.Marshal(data["accounts"])
		original, _ := json.Marshal(legacy["accounts"])
		if string(exported) != string(original) {
			t.Fatal("GET and legacy POST account statistics differ", string(exported), string(original))
		}
		rows := data["accounts"].([]any)
		if rows[1].(map[string]any)["id"] != second || rows[1].(map[string]any)["removed"] != true || rows[1].(map[string]any)["status"] != "offline" {
			t.Fatal("removed account history missing", rows)
		}
		for _, forbidden := range []string{f.raw, f.client, f.code, f.device, token, "4477009000", "PRIVATE-UNSELECTED", "8613999999999", "password_hash", "token_cipher", "proxyHost"} {
			if strings.Contains(string(exported), forbidden) {
				t.Fatalf("export leaked private field %q", forbidden)
			}
		}
	}
}

func TestWorkOrderGo7EmptyInvalidAndRevokedLinks(t *testing.T) {
	h := setup(t)
	f := publicWorkOrderClient(t, h)
	account := f.account(t, "export lifecycle", "whatsapp", "8613800000001", time.Now())
	for _, reason := range []string{"empty", "disabled", "expired", "rotated", "deleted"} {
		order := h.commerceCall(t, "POST", "/work-orders", h.admin, gin.H{"name": "go7 " + reason, "accountIds": []string{account}, "startAt": time.Now().Add(-time.Hour), "enabled": true})["id"].(string)
		token := publicWorkOrderToken(t, h, order)
		switch reason {
		case "empty":
			if _, err := h.app.DB.Exec(context.Background(), `DELETE FROM work_order_accounts WHERE order_id=$1`, order); err != nil {
				t.Fatal(err)
			}
		case "disabled":
			if _, err := h.app.DB.Exec(context.Background(), `UPDATE work_orders SET enabled=false WHERE id=$1`, order); err != nil {
				t.Fatal(err)
			}
		case "expired":
			if _, err := h.app.DB.Exec(context.Background(), `UPDATE work_orders SET expires_at=now()-interval '1 second' WHERE id=$1`, order); err != nil {
				t.Fatal(err)
			}
		case "rotated":
			h.commerceCall(t, "POST", "/work-orders/"+order+"/rotate", h.admin, gin.H{})
		case "deleted":
			h.commerceCall(t, "DELETE", "/work-orders/"+order, h.admin, nil)
		}
		for _, suffix := range []string{"?api=go7", "/accounts"} {
			status, body := h.call("GET", "/public/work-orders/"+token+suffix, "", nil)
			if reason != "empty" {
				if status != 404 || body["data"] != nil {
					t.Fatal("revoked export accessible", reason, status, body)
				}
				continue
			}
			if status != 200 {
				t.Fatal(status, body)
			}
			data := body["data"].(map[string]any)
			accounts, ok := data["accounts"].([]any)
			if !ok || len(accounts) != 0 || data["total"] != float64(0) {
				t.Fatal("empty accounts must be an array", data)
			}
		}
	}
	for _, token := range []string{"invalid", strings.Repeat("x", 43)} {
		if status, body := h.call("GET", "/public/work-orders/"+token+"?api=go7", "", nil); status != 404 || body["data"] != nil {
			t.Fatal("invalid token exposed data", status, body)
		}
	}
}

func TestWorkOrderGo7PasswordHeaderAndRateLimit(t *testing.T) {
	h := setup(t)
	f := publicWorkOrderClient(t, h)
	account := f.account(t, "protected export", "whatsapp", "8613800000001", time.Now())
	order := h.commerceCall(t, "POST", "/work-orders", h.admin, gin.H{"name": "protected export", "accountIds": []string{account}, "startAt": time.Now().Add(-time.Hour), "enabled": true, "password": "share-secret"})["id"].(string)
	token := publicWorkOrderToken(t, h, order)
	for i, entry := range []struct {
		password, suffix string
		status           int
	}{
		{"", "?api=go7", 403}, {"wrong", "?api=go7", 403}, {"", "?api=go7&password=share-secret", 403},
		{"share-secret", "?api=go7", 200}, {strings.Repeat("x", 73), "?api=go7", 400}, {"share-secret", "/accounts", 200},
	} {
		req := httptest.NewRequest("GET", "/api/v1/public/work-orders/"+token+entry.suffix, nil)
		req.Header.Set("X-Work-Order-Password", entry.password)
		response := httptest.NewRecorder()
		h.r.ServeHTTP(response, req)
		if response.Code != entry.status || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.HasPrefix(response.Header().Get("Content-Type"), "application/json") {
			t.Fatal("password/header mismatch", i, response.Code, response.Header())
		}
	}
	// Five requests above used the main route; all requests, even errors, consume its IP budget.
	for i := 6; i <= 13; i++ {
		req := httptest.NewRequest("GET", "/api/v1/public/work-orders/"+token+"?api=go7", nil)
		req.Header.Set("X-Work-Order-Password", "share-secret")
		response := httptest.NewRecorder()
		h.r.ServeHTTP(response, req)
		want := 200
		if i == 13 {
			want = 429
		}
		if response.Code != want || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("rate limit/cache contract", i, response.Code, response.Header())
		}
	}
}
