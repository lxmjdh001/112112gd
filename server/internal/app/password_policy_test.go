package app

import (
	"github.com/gin-gonic/gin"
	"strings"
	"testing"
)

func TestAccountPasswordPolicy(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	for _, length := range []int{7, 8, 16, 17} {
		password := strings.Repeat("a", length)
		name := strings.Repeat("u", length)
		status, _ := h.call("POST", "/auth/register", "", gin.H{"username": name, "password": password, "teamName": name})
		expected := 400
		if length == 8 || length == 16 {
			expected = 200
		}
		if status != expected {
			t.Fatalf("registration length %d: got %d, want %d", length, status, expected)
		}
	}
	token := h.member(t, "password-policy", "")
	current := "test-pass-12345"
	for _, length := range []int{7, 8, 17, 16} {
		password := strings.Repeat("b", length)
		status, _ := h.call("POST", "/account/password", token, gin.H{"currentPassword": current, "newPassword": password})
		expected := 400
		if length == 8 || length == 16 {
			expected = 200
		}
		if status != expected {
			t.Fatalf("change length %d: got %d, want %d", length, status, expected)
		}
		if expected == 200 {
			current = password
		}
	}
	h.commerceCall(t, "POST", "/auth/login", "", gin.H{"username": "password-policy", "password": current})
}
