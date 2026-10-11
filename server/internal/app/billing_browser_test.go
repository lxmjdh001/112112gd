package app

import (
	"context"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"
)

// An isolated schema; no real company balances or accounts are used.
func TestBillingBrowserFixture(t *testing.T) {
	dest := os.Getenv("GONGDAN_BILLING_E2E_PATH")
	if dest == "" {
		t.Skip("browser fixture not requested")
	}
	h := setup(t)
	token, account := toolsClient(t, h, "演示销售账号")
	if _, e := h.app.DB.Exec(context.Background(), `UPDATE wallets SET available_cents=10000 WHERE kind='balance'`); e != nil {
		t.Fatal(e)
	}
	h.commerceCall(t, "POST", "/client/accounts/"+account+"/status", token, gin.H{"status": "ready", "identifier": "15550000001"})
	done := make(chan struct{})
	var once sync.Once
	h.r.POST("/__fixture/stop", func(c *gin.Context) { c.Status(200); once.Do(func() { close(done) }) })
	server := httptest.NewServer(h.r)
	defer server.Close()
	data, _ := json.Marshal(gin.H{"apiURL": server.URL, "username": "admin", "password": "test-password-only-123"})
	if e := os.WriteFile(dest, data, 0600); e != nil {
		t.Fatal(e)
	}
	select {
	case <-done:
	case <-time.After(4 * time.Minute):
		t.Fatal("browser fixture timed out")
	}
}
