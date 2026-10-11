package app

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoginLimitsBehindTrustedProxy(t *testing.T) {
	r := New(nil, make([]byte, 32)).Routes()
	call := func(remote, real, forwarded string) int {
		req := httptest.NewRequest("POST", "/api/v1/client/auth", strings.NewReader(`{}`))
		req.RemoteAddr = remote
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Real-IP", real)
		req.Header.Set("X-Forwarded-For", forwarded)
		out := httptest.NewRecorder()
		r.ServeHTTP(out, req)
		return out.Code
	}
	for range 12 {
		if status := call("127.0.0.1:45000", "192.0.2.1", ""); status != 400 {
			t.Fatalf("unexpected validation status: %d", status)
		}
	}
	if status := call("127.0.0.1:45000", "192.0.2.1", "192.0.2.9"); status != 429 {
		t.Fatalf("forwarded-for bypassed limit: %d", status)
	}
	if status := call("127.0.0.1:45000", "192.0.2.2", ""); status != 400 {
		t.Fatalf("one visitor blocked another: %d", status)
	}
	for range 12 {
		if status := call("198.51.100.1:45000", "192.0.2.3", ""); status != 400 {
			t.Fatalf("unexpected direct-client status: %d", status)
		}
	}
	if status := call("198.51.100.1:45000", "192.0.2.4", "192.0.2.5"); status != 429 {
		t.Fatalf("untrusted client spoofed its address: %d", status)
	}
}
