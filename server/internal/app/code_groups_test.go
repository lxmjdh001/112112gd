package app

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gongdan007/server/internal/security"
)

func (h *harness) group(t *testing.T, name string) string {
	t.Helper()
	status, body := h.call("POST", "/login-code-groups", h.admin, gin.H{"name": name})
	if status != 200 {
		t.Fatalf("create group: %d %v", status, body)
	}
	return body["data"].(map[string]any)["id"].(string)
}
func (h *harness) codeGroup(t *testing.T, codeID string) (string, string) {
	t.Helper()
	status, body := h.call("GET", "/login-codes", h.admin, nil)
	if status != 200 {
		t.Fatal(body)
	}
	for _, item := range body["data"].([]any) {
		row := item.(map[string]any)
		if row["id"] == codeID {
			return row["groupId"].(string), row["groupName"].(string)
		}
	}
	t.Fatal("code missing after group operation")
	return "", ""
}
func TestCodeGroupLifecyclePreservesLogin(t *testing.T) {
	h := setup(t)
	codeID, raw := h.code(t)
	if id, _ := h.codeGroup(t, codeID); id != "" {
		t.Fatal("existing code should be ungrouped")
	}
	status, body := h.login(raw, "group-user")
	if status != 200 {
		t.Fatal(body)
	}
	client := body["data"].(map[string]any)["accessToken"].(string)
	group := h.group(t, "  投放一组  ")
	for _, name := range []string{"", "   ", "未分组", "全部分组", strings.Repeat("字", 51)} {
		if s, _ := h.call("POST", "/login-code-groups", h.admin, gin.H{"name": name}); s != 400 {
			t.Fatalf("invalid name accepted: %q (%d)", name, s)
		}
	}
	if s, _ := h.call("POST", "/login-code-groups", h.admin, gin.H{"name": "投放一组"}); s != 409 {
		t.Fatal("duplicate allowed", s)
	}
	status, body = h.call("POST", "/login-codes", h.admin, gin.H{"allowedPlatforms": []string{"whatsapp"}, "label": "投手", "groupId": group, "expiresAt": time.Now().Add(time.Hour)})
	if status != 200 {
		t.Fatal(body)
	}
	newID := body["data"].(map[string]any)["id"].(string)
	if id, name := h.codeGroup(t, newID); id != group || name != "投放一组" {
		t.Fatal("create did not assign trimmed group", id, name)
	}
	if s, d := h.call("POST", "/login-codes/move-group", h.admin, gin.H{"ids": []string{codeID, newID}, "groupId": group}); s != 200 {
		t.Fatal(d)
	}
	_, body = h.call("GET", "/login-code-groups", h.admin, nil)
	list := body["data"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["codeCount"] != float64(2) {
		t.Fatal("wrong group count", body)
	}
	if s, _ := h.call("PATCH", "/login-code-groups/"+group, h.admin, gin.H{"name": "投放二组"}); s != 200 {
		t.Fatal("rename failed", s)
	}
	if id, name := h.codeGroup(t, codeID); id != group || name != "投放二组" {
		t.Fatal("rename lost identity or name not propagated")
	}
	if s, _ := h.call("POST", "/login-codes/move-group", h.admin, gin.H{"ids": []string{newID}, "groupId": ""}); s != 200 {
		t.Fatal("move to ungrouped failed")
	}
	if id, _ := h.codeGroup(t, newID); id != "" {
		t.Fatal("not moved to ungrouped")
	}
	if s, _ := h.call("DELETE", "/login-code-groups/"+group, h.admin, nil); s != 200 {
		t.Fatal("delete failed", s)
	}
	if id, _ := h.codeGroup(t, codeID); id != "" {
		t.Fatal("delete did not ungroup")
	}
	if s, _ := h.call("POST", "/client/heartbeat", client, gin.H{}); s != 200 {
		t.Fatal("group operations revoked client", s)
	}
	if s, _ := h.login(raw, "group-user"); s != 200 {
		t.Fatal("group operations invalidated login code", s)
	}
}

func TestCodeGroupTenantBoundaryAndAtomicMove(t *testing.T) {
	h := setup(t)
	group := h.group(t, "我的分组")
	codeID, raw := h.code(t)
	ctx := context.Background()
	var otherTenant, otherGroup, otherCode string
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO tenants(name) VALUES('other') RETURNING id::text`).Scan(&otherTenant); err != nil {
		t.Fatal(err)
	}
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO login_code_groups(tenant_id,name) VALUES($1,'我的分组') RETURNING id::text`, otherTenant).Scan(&otherGroup); err != nil {
		t.Fatal(err)
	}
	if err := h.app.DB.QueryRow(ctx, `INSERT INTO login_codes(tenant_id,label,code_hash,suffix,expires_at) VALUES($1,'other',$2,'suffix',now()+interval '1 day') RETURNING id::text`, otherTenant, security.Hash(security.Token())).Scan(&otherCode); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"PATCH", "DELETE"} {
		if s, _ := h.call(method, "/login-code-groups/"+otherGroup, h.admin, gin.H{"name": "new"}); s != 404 {
			t.Fatal("foreign group mutation allowed", method, s)
		}
	}
	if s, _ := h.call("POST", "/login-codes", h.admin, gin.H{"allowedPlatforms": []string{"whatsapp"}, "label": "foreign", "groupId": otherGroup, "expiresAt": time.Now().Add(time.Hour)}); s != 404 {
		t.Fatal("foreign group create allowed", s)
	}
	for _, body := range []gin.H{
		{"ids": []string{codeID}, "groupId": otherGroup},
		{"ids": []string{codeID, otherCode}, "groupId": group},
		{"ids": []string{codeID, "not-a-code"}, "groupId": group},
	} {
		if s, _ := h.call("POST", "/login-codes/move-group", h.admin, body); s != 404 {
			t.Fatal("invalid batch allowed", body, s)
		}
		if id, _ := h.codeGroup(t, codeID); id != "" {
			t.Fatal("partial batch committed")
		}
	}
	for _, body := range []gin.H{
		{"ids": []string{}, "groupId": group},
		{"ids": []string{codeID, codeID}, "groupId": group},
		{"ids": []string{codeID}},
		{"ids": make([]string, 501), "groupId": group},
	} {
		if s, _ := h.call("POST", "/login-codes/move-group", h.admin, body); s != 400 {
			t.Fatal("invalid batch shape allowed", s)
		}
	}
	if _, err := h.app.DB.Exec(ctx, `UPDATE login_codes SET group_id=$1 WHERE id=$2`, otherGroup, codeID); err == nil {
		t.Fatal("database permitted cross-tenant association")
	}
	_, body := h.call("GET", "/login-code-groups", h.admin, nil)
	if len(body["data"].([]any)) != 1 {
		t.Fatal("foreign group exposed")
	}
	_, body = h.login(raw, "viewer")
	client := body["data"].(map[string]any)["accessToken"].(string)
	for _, route := range []struct{ method, path string }{
		{"GET", "/login-code-groups"}, {"POST", "/login-code-groups"},
		{"PATCH", "/login-code-groups/" + group}, {"DELETE", "/login-code-groups/" + group},
		{"POST", "/login-codes/move-group"},
	} {
		if s, _ := h.call(route.method, route.path, client, gin.H{"name": "bad", "ids": []string{codeID}, "groupId": group}); s != 401 {
			t.Fatal("client accessed group management", route, s)
		}
	}
}

func TestCodeGroupMoveConcurrentWithDelete(t *testing.T) {
	h := setup(t)
	codeID, _ := h.code(t)
	for i := range 5 {
		group := h.group(t, fmt.Sprintf("group-%d", i))
		var wg sync.WaitGroup
		var moved, deleted int
		wg.Add(2)
		go func() {
			defer wg.Done()
			moved, _ = h.call("POST", "/login-codes/move-group", h.admin, gin.H{"ids": []string{codeID}, "groupId": group})
		}()
		go func() { defer wg.Done(); deleted, _ = h.call("DELETE", "/login-code-groups/"+group, h.admin, nil) }()
		wg.Wait()
		if (moved != 200 && moved != 404) || deleted != 200 {
			t.Fatal("concurrent group operations failed", moved, deleted)
		}
		if id, _ := h.codeGroup(t, codeID); id != "" {
			t.Fatal("dangling group association")
		}
	}
}
