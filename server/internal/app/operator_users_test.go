package app

import (
	"encoding/json"
	"github.com/gin-gonic/gin"
	"strings"
	"testing"
)

func TestOperatorUserManagement(t *testing.T) {
	h := setup(t)
	h.commerceConfig(t)
	member := h.member(t, "operator-user-customer", "")
	other := h.member(t, "operator-user-other", "")
	for _, route := range []string{"/operations/users", "/operations/recharges", "/operations/withdrawals", "/operations/settings"} {
		if s, _ := h.call("GET", route, member, nil); s != 403 {
			t.Fatalf("member allowed %s: %d", route, s)
		}
	}
	info := h.commerceCall(t, "GET", "/user/info", h.admin, nil)
	roleJSON, _ := json.Marshal(info["roles"])
	if !strings.Contains(string(roleJSON), "operator") {
		t.Fatal("operator role missing", info)
	}
	data := h.commerceCall(t, "GET", "/operations/users?search=operator-user-customer&role=customer", h.admin, nil)
	items := data["items"].([]any)
	if len(items) != 1 {
		t.Fatal(data)
	}
	id := items[0].(map[string]any)["id"].(string)
	for _, path := range []string{"/operations/users/" + id + "/status", "/operations/users/" + id + "/password"} {
		method := "POST"
		body := gin.H{"password": "new-pass-12345"}
		if strings.HasSuffix(path, "status") {
			method = "PATCH"
			body = gin.H{"enabled": false}
		}
		if s, _ := h.call(method, path, member, body); s != 403 {
			t.Fatal("member write access", s)
		}
	}
	h.commerceCall(t, "PATCH", "/operations/users/"+id+"/status", h.admin, gin.H{"enabled": false})
	if s, _ := h.call("GET", "/account/profile", member, nil); s != 401 {
		t.Fatal("disabled session remained", s)
	}
	if s, _ := h.call("POST", "/auth/login", "", gin.H{"username": "operator-user-customer", "password": "test-pass-12345"}); s != 401 {
		t.Fatal("disabled login succeeded", s)
	}
	h.commerceCall(t, "GET", "/account/profile", other, nil)
	disabled := h.commerceCall(t, "GET", "/operations/users?status=disabled", h.admin, nil)
	if len(disabled["items"].([]any)) != 1 {
		t.Fatal(disabled)
	}
	h.commerceCall(t, "PATCH", "/operations/users/"+id+"/status", h.admin, gin.H{"enabled": true})
	session := h.commerceCall(t, "POST", "/auth/login", "", gin.H{"username": "operator-user-customer", "password": "test-pass-12345"})["accessToken"].(string)
	for _, n := range []int{7, 17} {
		if s, _ := h.call("POST", "/operations/users/"+id+"/password", h.admin, gin.H{"password": strings.Repeat("a", n)}); s != 400 {
			t.Fatal("password length", n, s)
		}
	}
	h.commerceCall(t, "POST", "/operations/users/"+id+"/password", h.admin, gin.H{"password": "new-pass-12345"})
	if s, _ := h.call("GET", "/account/profile", session, nil); s != 401 {
		t.Fatal("reset session remained", s)
	}
	if s, _ := h.call("POST", "/auth/login", "", gin.H{"username": "operator-user-customer", "password": "test-pass-12345"}); s != 401 {
		t.Fatal("old password works", s)
	}
	h.commerceCall(t, "POST", "/auth/login", "", gin.H{"username": "operator-user-customer", "password": "new-pass-12345"})
	adminID := info["userId"].(string)
	if s, _ := h.call("PATCH", "/operations/users/"+adminID+"/status", h.admin, gin.H{"enabled": false}); s != 403 {
		t.Fatal("admin protection", s)
	}
	if s, _ := h.call("POST", "/operations/users/"+adminID+"/password", h.admin, gin.H{"password": "new-pass-12345"}); s != 403 {
		t.Fatal("admin password protection", s)
	}
	if s, _ := h.call("PATCH", "/operations/users/not-a-uuid/status", h.admin, gin.H{"enabled": false}); s != 400 {
		t.Fatal("bad ID", s)
	}
	if s, _ := h.call("GET", "/operations/users?role=invalid", h.admin, nil); s != 400 {
		t.Fatal("invalid role", s)
	}
}
