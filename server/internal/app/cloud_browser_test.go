package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// This fixture exists only in the test binary. Every Graph API request goes to
// setupCloud's mock; it never pairs an account or contacts a real customer.
func TestCloudBrowserFixture(t *testing.T) {
	dest := os.Getenv("GONGDAN_CLOUD_E2E_PATH")
	if dest == "" {
		t.Skip("browser fixture not requested")
	}
	h := setupCloud(t)
	h.app.TranslationHTTP = &http.Client{Transport: cloudTranslationTransport(func(r *http.Request) (*http.Response, error) {
		text := r.URL.Query().Get("tl") + ": " + r.URL.Query().Get("q")
		body, _ := json.Marshal([]any{[]any{[]any{text}}, nil, "auto"})
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})}
	n := h.number(t, "200001")
	h.receive(t, n, "200001", "wamid.browser.1", "15550001111", time.Now())
	code := h.commerceCall(t, "POST", "/login-codes", h.admin, gin.H{"label": "API 验收登录码", "allowedPlatforms": []string{"whatsapp_cloud"}, "expiresAt": time.Now().Add(time.Hour)})
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+n+"/assignments", h.admin, gin.H{"codeIds": []string{code["id"].(string)}})
	h.commerceCall(t, "POST", "/whatsapp-cloud/numbers/"+n+"/templates/sync", h.admin, gin.H{})
	done := make(chan struct{})
	var once sync.Once
	h.r.POST("/__fixture/stop", func(c *gin.Context) { c.Status(200); once.Do(func() { close(done) }) })
	server := httptest.NewServer(h.r)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() { defer close(stopped); h.app.RunCloudOutbox(ctx) }()
	defer func() { cancel(); <-stopped }()
	settings := gin.H{"apiURL": server.URL, "adminToken": h.admin, "username": "admin", "password": "test-password-only-123", "code": code["code"], "codeId": code["id"], "numberId": n, "appSecret": cloudSecret, "token": cloudToken}
	data, _ := json.Marshal(settings)
	if e := os.WriteFile(dest, data, 0600); e != nil {
		t.Fatal(e)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Minute):
		t.Fatal("browser fixture timed out")
	}
}
