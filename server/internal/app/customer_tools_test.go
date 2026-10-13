package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/png"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func toolsClient(t *testing.T, h *harness, device string) (string, string) {
	t.Helper()
	_, raw := h.code(t)
	status, login := h.login(raw, device)
	if status != 200 {
		t.Fatal("client login failed", status)
	}
	token := login["data"].(map[string]any)["accessToken"].(string)
	account := h.commerceCall(t, "POST", "/client/accounts", token, gin.H{"label": device, "platform": "whatsapp", "proxyId": "", "requestId": key(1400)})["id"].(string)
	return token, account
}

func TestCustomerToolsProfilesAndTags(t *testing.T) {
	h := setup(t)
	token, account := toolsClient(t, h, "tools-one")
	secondToken, secondAccount := toolsClient(t, h, "tools-two")
	body := gin.H{"accountId": account, "identifier": "+44 7410 419512"}
	call := func(method, route, token string, body any) map[string]any {
		return h.commerceCall(t, method, "/client/tools"+route, token, body)
	}
	first := call("POST", "/customer", token, body)
	if first["version"] != float64(0) || first["language"] != "en" {
		t.Fatal("invalid default", first)
	}
	body["version"], body["language"], body["details"] = 0, "ja", gin.H{"notes": "重要客户，待跟进", "name": "ERIC", "level": "核心"}
	saved := call("PUT", "/customer", token, body)
	if saved["version"] != float64(1) {
		t.Fatal(saved)
	}
	if s, _ := h.call("PUT", "/client/tools/customer", token, body); s != 409 {
		t.Fatal("stale overwrite allowed", s)
	}
	body["version"] = 1
	body["language"] = "invalid"
	if s, _ := h.call("PUT", "/client/tools/customer", token, body); s != 400 {
		t.Fatal("invalid language allowed", s)
	}
	body["language"] = "ja"
	tag := call("POST", "/tags", token, gin.H{"name": "潜在客户"})["id"].(string)
	assignment := gin.H{"accountId": account, "identifier": "447410419512", "tagId": tag, "assigned": true}
	for range 2 {
		if s, d := h.call("PUT", "/client/tools/customer/tag", token, assignment); s != 200 {
			t.Fatal("tag assignment", s, d)
		}
	}
	// Profiles are shared by team + platform + customer, across service accounts.
	shared := call("POST", "/customer", secondToken, gin.H{"accountId": secondAccount, "identifier": "447410419512"})
	if shared["language"] != "ja" || shared["details"].(map[string]any)["notes"] != "重要客户，待跟进" || len(shared["tags"].([]any)) != 1 {
		t.Fatal("profile did not follow customer", shared)
	}
	other := call("POST", "/customer", token, gin.H{"accountId": account, "identifier": "447410419513"})
	if other["version"] != float64(0) || len(other["tags"].([]any)) != 0 {
		t.Fatal("customer data leaked", other)
	}
	if s, _ := h.call("POST", "/client/tools/customer", secondToken, body); s != 404 {
		t.Fatal("unowned account access allowed", s)
	}
	var tenant, foreignTag string
	if err := h.app.DB.QueryRow(context.Background(), `INSERT INTO tenants(name) VALUES('other tools tenant') RETURNING id::text`).Scan(&tenant); err != nil {
		t.Fatal(err)
	}
	if err := h.app.DB.QueryRow(context.Background(), `INSERT INTO customer_tags(tenant_id,name) VALUES($1,'foreign') RETURNING id::text`, tenant).Scan(&foreignTag); err != nil {
		t.Fatal(err)
	}
	assignment["tagId"] = foreignTag
	if s, _ := h.call("PUT", "/client/tools/customer/tag", token, assignment); s != 404 {
		t.Fatal("foreign tag allowed", s)
	}
	assignment["tagId"], assignment["assigned"] = tag, false
	if s, d := h.call("PUT", "/client/tools/customer/tag", token, assignment); s != 200 {
		t.Fatal(s, d)
	}
}

func TestCustomerToolsAssetsVisibilityAndImages(t *testing.T) {
	h := setup(t)
	token, _ := toolsClient(t, h, "asset-one")
	other, _ := toolsClient(t, h, "asset-two")
	body := gin.H{"kind": "text", "scope": "personal", "title": "发货", "body": "货已发出，约四天到达", "category": "售后"}
	asset := h.commerceCall(t, "POST", "/client/tools/assets", token, body)["id"].(string)
	for _, method := range []string{"GET", "DELETE"} {
		if s, _ := h.call(method, "/client/tools/assets/"+asset, other, nil); s != 404 {
			t.Fatal("private asset exposed", method, s)
		}
	}
	body["scope"] = "team"
	team := h.commerceCall(t, "POST", "/client/tools/assets", token, body)["id"].(string)
	if s, d := h.call("GET", "/client/tools/assets/"+team, other, nil); s != 200 {
		t.Fatal("team asset missing", s, d)
	}
	status, list := h.call("GET", "/client/tools/assets", other, nil)
	if status != 200 || len(list["data"].([]any)) != 1 {
		t.Fatal("private assets listed", status)
	}
	body["version"] = 1
	h.commerceCall(t, "PATCH", "/client/tools/assets/"+team, other, body)
	if s, _ := h.call("PATCH", "/client/tools/assets/"+team, token, body); s != 409 {
		t.Fatal("stale asset overwrite", s)
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	data := base64.StdEncoding.EncodeToString(encoded.Bytes())
	picture := gin.H{"kind": "image", "scope": "personal", "title": "报价表", "mime": "image/png", "filename": "报价.png", "data": data}
	imageID := h.commerceCall(t, "POST", "/client/tools/assets", token, picture)["id"].(string)
	var cipher string
	if err := h.app.DB.QueryRow(context.Background(), `SELECT data_cipher FROM quick_assets WHERE id=$1`, imageID).Scan(&cipher); err != nil {
		t.Fatal(err)
	}
	if cipher == data || cipher == "" {
		t.Fatal("image not encrypted")
	}
	fetched := h.commerceCall(t, "GET", "/client/tools/assets/"+imageID, token, nil)
	if fetched["data"] != data || fetched["mime"] != "image/png" {
		t.Fatal("image roundtrip failed")
	}
	picture["data"] = base64.StdEncoding.EncodeToString([]byte("not an image"))
	if s, _ := h.call("POST", "/client/tools/assets", token, picture); s != 400 {
		t.Fatal("invalid image accepted", s)
	}
	picture["data"], picture["mime"] = data, "image/jpeg"
	if s, _ := h.call("POST", "/client/tools/assets", token, picture); s != 400 {
		t.Fatal("mime mismatch accepted", s)
	}
	if s, _ := h.call("DELETE", "/client/tools/assets/"+imageID, token, nil); s != 200 {
		t.Fatal("delete failed", s)
	}
	if s, _ := h.call("GET", "/client/tools/assets/"+imageID, token, nil); s != 404 {
		t.Fatal("deleted image accessible", s)
	}
}

func TestCustomerToolsCloudAccountScope(t *testing.T) {
	h := setupCloud(t)
	number := h.number(t, "200001")
	code, token := h.codeClient(t)
	body := gin.H{"accountId": number, "identifier": "447410419512", "details": gin.H{"notes": "API 客户"}, "language": "fr", "version": 0}
	if s, _ := h.call("PUT", "/client/tools/customer", token, body); s != 404 {
		t.Fatal("unassigned cloud access", s)
	}
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+number+"/assignments", h.admin, gin.H{"codeIds": []string{code}})
	h.commerceCall(t, "PUT", "/client/tools/customer", token, body)
	native, account := toolsClient(t, h.harness, "native-cloud-profile")
	profile := h.commerceCall(t, "POST", "/client/tools/customer", native, gin.H{"accountId": account, "identifier": "447410419512"})
	if profile["language"] != "fr" || profile["details"].(map[string]any)["notes"] != "API 客户" {
		t.Fatal("same-platform profile not shared", profile)
	}
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+number+"/assignments", h.admin, gin.H{"codeIds": []string{}})
	if s, _ := h.call("POST", "/client/tools/customer", token, body); s != 404 {
		t.Fatal("revoked assignment retained access", s)
	}
}

func TestCustomerToolsNativePlatforms(t *testing.T) {
	h := setup(t)
	code := h.commerceCall(t, "POST", "/login-codes", h.admin, gin.H{"label": "多平台工具", "allowedPlatforms": []string{"line", "telegram", "whatsapp"}, "expiresAt": time.Now().Add(time.Hour)})
	_, login := h.login(code["code"].(string), "native-tools")
	token := login["data"].(map[string]any)["accessToken"].(string)
	tag := h.commerceCall(t, "POST", "/client/tools/tags", token, gin.H{"name": "重点客户"})["id"].(string)
	for i, platform := range []string{"line", "telegram", "whatsapp"} {
		account := h.commerceCall(t, "POST", "/client/accounts", token, gin.H{"label": platform, "platform": platform, "proxyId": "", "requestId": key(1580 + i)})["id"].(string)
		identifier := "447700900001"
		if platform == "line" {
			identifier = "u11111111111111111111111111111111"
		}
		body := gin.H{"accountId": account, "identifier": identifier, "details": gin.H{"notes": platform + " notes"}, "language": "ja", "version": 0}
		h.commerceCall(t, "PUT", "/client/tools/customer", token, body)
		h.commerceCall(t, "PUT", "/client/tools/customer/tag", token, gin.H{"accountId": account, "identifier": identifier, "tagId": tag, "assigned": true})
		got := h.commerceCall(t, "POST", "/client/tools/customer", token, body)
		if got["platform"] != platform || got["details"].(map[string]any)["notes"] != platform+" notes" || len(got["tags"].([]any)) != 1 {
			t.Fatal(got)
		}
		if platform == "telegram" {
			for _, bad := range []string{"-100123", "same display name", "@handle", "0"} {
				if status, _ := h.call("POST", "/client/tools/customer", token, gin.H{"accountId": account, "identifier": bad}); status != 400 {
					t.Fatal("unsafe Telegram identity", bad, status)
				}
			}
		}
	}
}
