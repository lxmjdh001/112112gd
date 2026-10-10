package app

import (
	"context"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gongdan007/server/internal/security"
)

func TestPersistentClientSessionAndRevocation(t *testing.T) {
	for _, reason := range []string{"logout", "code-expiry", "code-disable", "code-reset", "device-unbind"} {
		t.Run(reason, func(t *testing.T) {
			h := setup(t)
			id, code := h.code(t)
			status, result := h.login(code, "persistent-device")
			if status != 200 {
				t.Fatal("login failed", status)
			}
			data := result["data"].(map[string]any)
			token := data["accessToken"].(string)
			device := data["deviceId"].(string)
			ctx := context.Background()
			var durable bool
			if err := h.app.DB.QueryRow(ctx, `SELECT expires_at='infinity'::timestamptz FROM client_sessions WHERE token_hash=$1`, security.Hash(token)).Scan(&durable); err != nil || !durable {
				t.Fatal("client session must not have an independent timeout", err)
			}
			if _, err := h.app.DB.Exec(ctx, `UPDATE devices SET last_seen=now()-interval '1 year' WHERE id=$1`, device); err != nil {
				t.Fatal(err)
			}
			// Neither a long absence nor a new API instance invalidates an authorized device.
			h.r = New(h.app.DB, make([]byte, 32)).Routes()
			if status, _ = h.call("POST", "/client/heartbeat", token, gin.H{}); status != 200 {
				t.Fatal("idle/restart lost session", status)
			}
			switch reason {
			case "logout":
				status, _ = h.call("POST", "/client/logout", token, gin.H{})
				if status != 200 {
					t.Fatal("logout failed", status)
				}
			case "code-expiry":
				if _, err := h.app.DB.Exec(ctx, `UPDATE login_codes SET expires_at=now()-interval '1 second' WHERE id=$1`, id); err != nil {
					t.Fatal(err)
				}
			case "code-disable":
				status, _ = h.call("PATCH", "/login-codes/"+id, h.admin, gin.H{"label": "test", "enabled": false, "expiresAt": time.Now().Add(time.Hour)})
				if status != 200 {
					t.Fatal("disable failed", status)
				}
			case "code-reset":
				status, _ = h.call("POST", "/login-codes/"+id+"/reset", h.admin, gin.H{})
				if status != 200 {
					t.Fatal("reset failed", status)
				}
			case "device-unbind":
				status, _ = h.call("DELETE", "/devices/"+device, h.admin, nil)
				if status != 200 {
					t.Fatal("device unbind failed", status)
				}
			}
			if status, _ = h.call("POST", "/client/heartbeat", token, gin.H{}); status != 401 {
				t.Fatal("persistent session bypassed revocation", reason, status)
			}
		})
	}
}
