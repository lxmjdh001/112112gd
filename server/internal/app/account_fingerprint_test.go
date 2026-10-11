package app

import (
	"encoding/json"
	"github.com/gin-gonic/gin"
	"reflect"
	"testing"
	"time"
)

func fingerprintFixture() *accountFingerprint {
	return &accountFingerprint{Version: 1, Seed: "00112233445566778899aabbccddeeff", OS: "windows", UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36", GPUVendor: "Test vendor", GPURenderer: "Test renderer", ScreenWidth: 1920, ScreenHeight: 1080, Timezone: "Asia/Tokyo", Language: "ja-JP", HardwareConcurrency: 8, DeviceMemory: 4, WebRTC: "proxy", CanvasNoise: true, AudioNoise: true, WebGLNoise: true}
}
func TestAccountFingerprintPersistenceValidationAndRetry(t *testing.T) {
	h := setup(t)
	code := h.commerceCall(t, "POST", "/login-codes", h.admin, gin.H{"label": "指纹配置", "allowedPlatforms": []string{"whatsapp"}, "expiresAt": time.Now().Add(time.Hour)})
	_, login := h.login(code["code"].(string), "fingerprint-device")
	client := login["data"].(map[string]any)["accessToken"].(string)
	p := fingerprintFixture()
	body := gin.H{"label": "独立浏览器", "platform": "whatsapp", "proxyId": "", "requestId": key(7500), "fingerprint": p}
	id := h.commerceCall(t, "POST", "/client/accounts", client, body)["id"].(string)
	if retry := h.commerceCall(t, "POST", "/client/accounts", client, body)["id"]; retry != id {
		t.Fatal("retry duplicated account")
	}
	for range 2 {
		opened := h.commerceCall(t, "POST", "/client/accounts/"+id+"/open", client, gin.H{})
		raw, _ := json.Marshal(opened["fingerprint"])
		var saved accountFingerprint
		if err := json.Unmarshal(raw, &saved); err != nil || !reflect.DeepEqual(p, &saved) {
			t.Fatal("fingerprint not restored", err, saved)
		}
		h.commerceCall(t, "POST", "/client/accounts/"+id+"/close", client, gin.H{})
	}
	p.Seed = "ffeeddccbbaa99887766554433221100"
	if status, _ := h.call("POST", "/client/accounts", client, body); status != 409 {
		t.Fatal("changed retry fingerprint accepted", status)
	}
	body["requestId"] = key(7501)
	p.Timezone = "invalid/timezone"
	if status, _ := h.call("POST", "/client/accounts", client, body); status != 400 {
		t.Fatal("invalid timezone accepted", status)
	}
	p.Timezone = "Asia/Tokyo"
	p.UserAgent += "\r\nX-Test: wrong"
	if status, _ := h.call("POST", "/client/accounts", client, body); status != 400 {
		t.Fatal("unsafe UA accepted", status)
	}
	body["fingerprint"] = nil
	native := h.commerceCall(t, "POST", "/client/accounts", client, body)["id"].(string)
	if h.commerceCall(t, "POST", "/client/accounts/"+native+"/open", client, gin.H{})["fingerprint"] != nil {
		t.Fatal("native fingerprint changed")
	}
	otherCode := h.commerceCall(t, "POST", "/login-codes", h.admin, gin.H{"label": "其他登录码", "allowedPlatforms": []string{"whatsapp"}, "expiresAt": time.Now().Add(time.Hour)})
	_, other := h.login(otherCode["code"].(string), "other-device")
	otherToken := other["data"].(map[string]any)["accessToken"].(string)
	if status, _ := h.call("POST", "/client/accounts/"+id+"/open", otherToken, gin.H{}); status != 404 {
		t.Fatal("fingerprint exposed to another login code", status)
	}
}
