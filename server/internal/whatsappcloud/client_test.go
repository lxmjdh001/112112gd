package whatsappcloud

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateChecksTokenAppScopesAndPaginatedOwnership(t *testing.T) {
	pages := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "debug_token") {
			if r.Header.Get("Authorization") != "Bearer 12345|secret" {
				t.Error("app credential not used")
			}
			token := r.URL.Query().Get("input_token")
			switch token {
			case "wrong-app":
				io.WriteString(w, `{"data":{"is_valid":true,"app_id":"99999","scopes":["whatsapp_business_messaging","whatsapp_business_management"]}}`)
			case "missing-scope":
				io.WriteString(w, `{"data":{"is_valid":true,"app_id":"12345","scopes":["whatsapp_business_messaging"]}}`)
			default:
				io.WriteString(w, `{"data":{"is_valid":true,"app_id":"12345","scopes":["whatsapp_business_messaging","whatsapp_business_management"]}}`)
			}
			return
		}
		if r.URL.Path != "/v25.0/34567/phone_numbers" {
			t.Error("untrusted paging URL followed", r.URL.Path)
		}
		pages++
		if r.URL.Query().Get("after") == "cursor" {
			io.WriteString(w, `{"data":[{"id":"67890","display_phone_number":"+123456789","quality_rating":"GREEN"}]}`)
		} else {
			io.WriteString(w, `{"data":[],"paging":{"next":"https://untrusted.test/steal-token","cursors":{"after":"cursor"}}}`)
		}
	}))
	defer server.Close()
	c := New("v25.0")
	c.BaseURL = server.URL
	for _, bad := range []string{"wrong-app", "missing-scope"} {
		if _, e := c.Validate(context.Background(), "12345", "secret", bad, "34567", "67890"); e == nil {
			t.Fatal("invalid authorization accepted")
		}
	}
	if pages != 0 {
		t.Fatal("looked up numbers after invalid token")
	}
	n, e := c.Validate(context.Background(), "12345", "secret", "valid", "34567", "67890")
	if e != nil || n.ID != "67890" || pages != 2 {
		t.Fatal(n, e, pages)
	}
	if _, e = c.Validate(context.Background(), "12345", "secret", "valid", "34567", "88888"); e == nil {
		t.Fatal("unowned phone accepted")
	}
}
func TestSignatureAndRedactedErrors(t *testing.T) {
	raw := []byte(`{"object":"whatsapp_business_account"}`)
	mac := hmac.New(sha256.New, []byte("app-secret"))
	mac.Write(raw)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if !VerifySignature(raw, sig, "app-secret") || VerifySignature(append(raw, ' '), sig, "app-secret") || VerifySignature(raw, sig, "") || VerifySignature(raw, "sha256=invalid", "app-secret") {
		t.Fatal("signature validation failed")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "LEAK-TOKEN", "code": 190}})
	}))
	defer server.Close()
	c := New("v25.0")
	c.BaseURL = server.URL
	_, e := c.Send(context.Background(), "secret-token", "67890", json.RawMessage(`{}`))
	if e == nil || strings.Contains(e.Error(), "LEAK") || !strings.Contains(e.Error(), "授权") {
		t.Fatal("raw error or missing error", e)
	}
}
func TestMediaDownloadRejectsUnexpectedOrigin(t *testing.T) {
	target := "https://127.0.0.1/private"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"url": target, "mime_type": "image/png", "file_size": 1})
	}))
	defer server.Close()
	c := New("v25.0")
	c.BaseURL = server.URL
	for _, u := range []string{"https://127.0.0.1/private", "https://lookaside.fbsbx.com.evil.test/", "https://lookaside.fbsbx.com:444/", "http://lookaside.fbsbx.com/", "https://user:pass@lookaside.fbsbx.com/"} {
		target = u
		if _, _, e := c.Download(context.Background(), "token", "12345"); e == nil {
			t.Fatal("unsafe media origin accepted", u)
		}
	}
}
