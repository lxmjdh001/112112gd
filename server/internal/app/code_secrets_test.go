package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"gongdan007/server/internal/security"
)

func TestCopyCodePersistenceAndScope(t *testing.T) {
	h := setup(t)
	id, raw := h.code(t)
	ctx := context.Background()
	var encrypted string
	if err := h.app.DB.QueryRow(ctx, `SELECT code_cipher FROM login_codes WHERE id=$1`, id).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if encrypted == "" || strings.Contains(encrypted, raw) {
		t.Fatal("must retain only encrypted code")
	}
	if decoded, err := security.Open(h.app.Key, encrypted); err != nil || decoded != raw {
		t.Fatal("encrypted code cannot be recovered", err)
	}
	// A new API instance and repeated reads return exactly the originally issued code.
	h.r = New(h.app.DB, make([]byte, 32)).Routes()
	for range 2 {
		status, data := h.call("POST", "/login-codes/"+id+"/copy", h.admin, nil)
		if status != 200 || data["data"].(map[string]any)["code"] != raw {
			t.Fatal("copy did not return original code", status)
		}
	}
	_, list := h.call("GET", "/login-codes", h.admin, nil)
	encoded, _ := json.Marshal(list)
	if strings.Contains(string(encoded), raw) || strings.Contains(string(encoded), encrypted) {
		t.Fatal("list leaked full code or ciphertext")
	}
	if list["data"].([]any)[0].(map[string]any)["canCopy"] != true {
		t.Fatal("new code should be copyable")
	}
	status, data := h.login(raw, "copy-client")
	if status != 200 {
		t.Fatal("login failed", status)
	}
	client := data["data"].(map[string]any)["accessToken"].(string)
	for _, token := range []string{"", client} {
		if status, _ = h.call("POST", "/login-codes/"+id+"/copy", token, nil); status != 401 {
			t.Fatal("copy must require admin", status)
		}
		if status, _ = h.call("POST", "/login-codes/"+id+"/recover", token, gin.H{"code": raw}); status != 401 {
			t.Fatal("recover must require admin", status)
		}
	}
	h.commerceConfig(t)
	other := h.member(t, "copy-other-tenant", "")
	if status, _ = h.call("POST", "/login-codes/"+id+"/copy", other, nil); status != 404 {
		t.Fatal("cross-tenant disclosure", status)
	}
	if status, _ = h.call("POST", "/login-codes/"+id+"/recover", other, gin.H{"code": raw}); status != 400 {
		t.Fatal("cross-tenant recovery accepted", status)
	}
	// Neither copying nor recovering requires resetting a working client session.
	if status, _ = h.call("POST", "/client/heartbeat", client, gin.H{}); status != 200 {
		t.Fatal("copy disturbed active client", status)
	}
	status, data = h.call("POST", "/login-codes/"+id+"/reset", h.admin, gin.H{})
	if status != 200 {
		t.Fatal("reset failed", status)
	}
	replacement := data["data"].(map[string]any)["code"].(string)
	status, data = h.call("POST", "/login-codes/"+id+"/copy", h.admin, nil)
	if status != 200 || data["data"].(map[string]any)["code"] != replacement || replacement == raw {
		t.Fatal("copy returned pre-reset code", status)
	}
	if status, _ = h.call("POST", "/login-codes/"+id+"/recover", h.admin, gin.H{"code": raw}); status != 400 {
		t.Fatal("previous code restored after reset", status)
	}
	if status, _ = h.call("POST", "/client/heartbeat", client, gin.H{}); status != 401 {
		t.Fatal("reset did not revoke old client", status)
	}
	var leaked bool
	if err := h.app.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM audit_logs WHERE action LIKE '%' || $1 || '%' OR action LIKE '%' || $2 || '%')`, raw, replacement).Scan(&leaked); err != nil || leaked {
		t.Fatal("audit contains secret", err)
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE login_codes SET code_cipher='invalid' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if status, _ = h.call("POST", "/login-codes/"+id+"/copy", h.admin, nil); status != 500 {
		t.Fatal("corrupt ciphertext must not return success", status)
	}
}

func TestLegacyCodeRecoveryPreservesValueAndSession(t *testing.T) {
	h := setup(t)
	id, raw := h.code(t)
	status, data := h.login(raw, "legacy-device")
	if status != 200 {
		t.Fatal("login failed", status)
	}
	token := data["data"].(map[string]any)["accessToken"].(string)
	ctx := context.Background()
	clear := func() {
		t.Helper()
		if _, err := h.app.DB.Exec(ctx, `UPDATE login_codes SET code_cipher='' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
	clear()
	if status, _ = h.call("POST", "/login-codes/"+id+"/copy", h.admin, nil); status != 409 {
		t.Fatal("cannot reconstruct hash-only code", status)
	}
	_, data = h.call("GET", "/login-codes", h.admin, nil)
	if data["data"].([]any)[0].(map[string]any)["canCopy"] != false {
		t.Fatal("legacy code falsely marked copyable")
	}
	if status, _ = h.call("POST", "/login-codes/"+id+"/recover", h.admin, gin.H{"code": "GD7-" + security.Token()}); status != 400 {
		t.Fatal("wrong original code accepted", status)
	}
	if status, _ = h.call("POST", "/login-codes/"+id+"/recover", h.admin, gin.H{"code": "  " + raw + "\n"}); status != 200 {
		t.Fatal("original code recovery failed", status)
	}
	if status, _ = h.call("POST", "/client/heartbeat", token, gin.H{}); status != 200 {
		t.Fatal("recovery revoked active session", status)
	}
	status, data = h.call("POST", "/login-codes/"+id+"/copy", h.admin, nil)
	if status != 200 || data["data"].(map[string]any)["code"] != raw {
		t.Fatal("recovery changed code value", status)
	}
	// A subsequent successful legacy login automatically stores the original code.
	clear()
	if status, _ = h.login(raw, "legacy-device"); status != 200 {
		t.Fatal("legacy relogin failed", status)
	}
	status, data = h.call("POST", "/login-codes/"+id+"/copy", h.admin, nil)
	if status != 200 || data["data"].(map[string]any)["code"] != raw {
		t.Fatal("login failed to recover original code", status)
	}
}
