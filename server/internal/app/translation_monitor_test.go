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
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func seedTranslationMonitor(t *testing.T, h *harness) (string, string) {
	t.Helper()
	code, raw := h.code(t)
	var tenant, native, cloud string
	ctx := context.Background()
	if e := h.app.DB.QueryRow(ctx, `SELECT tenant_id::text FROM login_codes WHERE id=$1`, code).Scan(&tenant); e != nil {
		t.Fatal(e)
	}
	if e := h.app.DB.QueryRow(ctx, `INSERT INTO platform_accounts(tenant_id,code_id,label) VALUES($1,$2,'原生验收账号') RETURNING id::text`, tenant, code).Scan(&native); e != nil {
		t.Fatal(e)
	}
	if e := h.app.DB.QueryRow(ctx, `INSERT INTO platform_accounts(tenant_id,label,connection_type) VALUES($1,'API 验收号码','cloud') RETURNING id::text`, tenant).Scan(&cloud); e != nil {
		t.Fatal(e)
	}
	if _, e := h.app.DB.Exec(ctx, `INSERT INTO usage_records(tenant_id,account_id,request_id,provider,input_chars,output_chars,target_language)
 SELECT $1,$2,gen_random_uuid(),'google-free',10,8,'zh-CN' FROM generate_series(1,24)`, tenant, native); e != nil {
		t.Fatal(e)
	}
	if _, e := h.app.DB.Exec(ctx, `INSERT INTO usage_records(tenant_id,account_id,request_id,provider,input_chars,output_chars,target_language)
 SELECT $1,$2,gen_random_uuid(),'libretranslate',20,12,'pt' FROM generate_series(1,2)`, tenant, cloud); e != nil {
		t.Fatal(e)
	}
	if _, e := h.app.DB.Exec(ctx, `INSERT INTO usage_records(tenant_id,account_id,request_id,provider,input_chars,output_chars,target_language,created_at)
 VALUES($1,$2,gen_random_uuid(),'mymemory',30,40,'en',now()-interval '10 days')`, tenant, native); e != nil {
		t.Fatal(e)
	}
	return tenant, raw
}

func TestTranslationMonitorUsageAndIsolation(t *testing.T) {
	h := setup(t)
	_, raw := seedTranslationMonitor(t, h)
	data := h.commerceCall(t, "GET", "/translation/providers", h.admin, nil)
	items := data["items"].([]any)
	if len(items) != 3 {
		t.Fatal(data)
	}
	for i, want := range []float64{24, 0, 2} {
		row := items[i].(map[string]any)
		if row["requests"] != want || row["status"] != "unknown" || row["checkedAt"] != nil {
			t.Fatal(row)
		}
	}
	all := h.commerceCall(t, "GET", "/translation/providers?period=all", h.admin, nil)["items"].([]any)
	if all[1].(map[string]any)["requests"] != float64(1) {
		t.Fatal(all)
	}
	if items[0].(map[string]any)["inputChars"] != float64(240) || items[2].(map[string]any)["outputChars"] != float64(24) {
		t.Fatal(items)
	}
	page := h.commerceCall(t, "GET", "/translation/usage?provider=google-free&channel=web&page=2&pageSize=20&search=原生", h.admin, nil)
	if page["total"] != float64(24) || len(page["items"].([]any)) != 4 {
		t.Fatal(page)
	}
	page = h.commerceCall(t, "GET", "/translation/usage?provider=libretranslate&channel=cloud", h.admin, nil)
	if page["total"] != float64(2) || page["items"].([]any)[0].(map[string]any)["channel"] != "WhatsApp API" {
		t.Fatal(page)
	}
	page = h.commerceCall(t, "GET", "/translation/usage?provider=mymemory&period=7d", h.admin, nil)
	if page["total"] != float64(0) {
		t.Fatal(page)
	}
	for _, route := range []string{"/translation/providers?period=bad", "/translation/usage?provider=bad", "/translation/usage?channel=bad"} {
		if s, _ := h.call("GET", route, h.admin, nil); s != 400 {
			t.Fatal(route, s)
		}
	}
	h.commerceConfig(t)
	other := h.member(t, "translation-other", "")
	for _, route := range []string{"/translation/usage?period=all", "/translation/providers?period=all"} {
		out := h.commerceCall(t, "GET", route, other, nil)
		if strings.Contains(route, "usage") {
			if out["total"] != float64(0) {
				t.Fatal("cross-team usage", out)
			}
		} else {
			for _, v := range out["items"].([]any) {
				if v.(map[string]any)["requests"] != float64(0) {
					t.Fatal("cross-team aggregate", out)
				}
			}
		}
	}
	_, login := h.login(raw, "translation-client")
	client := login["data"].(map[string]any)["accessToken"].(string)
	for _, token := range []string{"", client} {
		for _, route := range []string{"/translation/providers", "/translation/usage"} {
			if s, _ := h.call("GET", route, token, nil); s != 401 {
				t.Fatal("unauthorized list", s)
			}
		}
		if s, _ := h.call("POST", "/translation/providers/google-free/check", token, gin.H{}); s != 401 {
			t.Fatal("unauthorized check", s)
		}
	}
}

func monitorProbeTransport(r *http.Request) (*http.Response, error) {
	status, body := 200, `{"translatedText":"你好"}`
	switch r.URL.Host {
	case "translate.googleapis.com":
		status, body = 429, "private upstream failure"
	case "api.mymemory.translated.net":
		body = `{"responseStatus":429,"quotaFinished":true,"responseData":{"translatedText":"private warning"}}`
	}
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
}

func TestTranslationMonitorChecksPersistAndDoNotCountAsUsage(t *testing.T) {
	h := setup(t)
	tenant, _ := seedTranslationMonitor(t, h)
	var calls atomic.Int32
	h.app.TranslationHTTP = &http.Client{Transport: cloudTranslationTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("credential sent to provider")
		}
		if r.Method == "GET" && r.URL.Query().Get("q") != "Hello" {
			t.Error("check did not use fixed synthetic text")
		}
		return monitorProbeTransport(r)
	})}
	for provider, status := range map[string]string{"google-free": "limited", "mymemory": "quota", "libretranslate": "available"} {
		out := h.commerceCall(t, "POST", "/translation/providers/"+provider+"/check", h.admin, gin.H{})
		if out["status"] != status || strings.Contains(out["message"].(string), "private") {
			t.Fatal(out)
		}
		if s, _ := h.call("POST", "/translation/providers/"+provider+"/check", h.admin, gin.H{}); s != 429 {
			t.Fatal("missing check cooldown", s)
		}
	}
	if calls.Load() != 3 {
		t.Fatal("check used failover or bypassed cooldown", calls.Load())
	}
	if s, _ := h.call("POST", "/translation/providers/unknown/check", h.admin, gin.H{}); s != 404 {
		t.Fatal(s)
	}
	var count int
	if e := h.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM usage_records`).Scan(&count); e != nil || count != 27 {
		t.Fatal("probes changed usage", count, e)
	}
	// A new App instance must obtain the saved results, with no request to a provider.
	fresh := New(h.app.DB, make([]byte, 32))
	h.r = fresh.Routes()
	out := h.commerceCall(t, "GET", "/translation/providers", h.admin, nil)
	for _, v := range out["items"].([]any) {
		if v.(map[string]any)["checkedAt"] == nil {
			t.Fatal("check not persisted", out)
		}
	}
	h.commerceConfig(t)
	other := h.member(t, "monitor-other", "")
	out = h.commerceCall(t, "GET", "/translation/providers", other, nil)
	for _, v := range out["items"].([]any) {
		if v.(map[string]any)["status"] != "unknown" {
			t.Fatal("cross-team check leak", out)
		}
	}
	_, e := h.app.DB.Exec(context.Background(), `UPDATE translation_provider_checks SET checked_at=now()-interval '16 minutes' WHERE tenant_id=$1 AND provider='google-free'`, tenant)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = h.app.DB.Exec(context.Background(), `UPDATE translation_provider_checks SET status='checking',checked_at=NULL,started_at=now()-interval '45 seconds' WHERE tenant_id=$1 AND provider='mymemory'`, tenant); e != nil {
		t.Fatal(e)
	}
	out = h.commerceCall(t, "GET", "/translation/providers", h.admin, nil)
	rows := out["items"].([]any)
	if rows[0].(map[string]any)["status"] != "stale" || rows[1].(map[string]any)["status"] != "interrupted" {
		t.Fatal(out)
	}
}

func TestTranslationMonitorConcurrentCheck(t *testing.T) {
	h := setup(t)
	var calls atomic.Int32
	h.app.TranslationHTTP = &http.Client{Transport: cloudTranslationTransport(func(r *http.Request) (*http.Response, error) { calls.Add(1); return monitorProbeTransport(r) })}
	var wg sync.WaitGroup
	statuses := make(chan int, 5)
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, _ := h.call("POST", "/translation/providers/libretranslate/check", h.admin, gin.H{})
			statuses <- s
		}()
	}
	wg.Wait()
	close(statuses)
	success := 0
	for s := range statuses {
		if s == 200 {
			success++
		} else if s != 429 {
			t.Fatal(s)
		}
	}
	if success != 1 || calls.Load() != 1 {
		t.Fatal("duplicate provider checks", success, calls.Load())
	}
}

func TestTranslationMonitorBrowserFixture(t *testing.T) {
	dest := os.Getenv("GONGDAN_TRANSLATION_E2E_PATH")
	if dest == "" {
		t.Skip("browser fixture not requested")
	}
	h := setup(t)
	seedTranslationMonitor(t, h)
	h.app.TranslationHTTP = &http.Client{Transport: cloudTranslationTransport(monitorProbeTransport)}
	done := make(chan struct{})
	var once sync.Once
	h.r.POST("/__fixture/stop", func(c *gin.Context) { c.Status(200); once.Do(func() { close(done) }) })
	server := httptest.NewServer(h.r)
	defer server.Close()
	data, _ := json.Marshal(gin.H{"apiURL": server.URL, "username": "admin", "password": "test-password-only-123"})
	if e := os.WriteFile(dest, data, 0600); e != nil {
		t.Fatal(e)
	}
	select {
	case <-done:
	case <-time.After(4 * time.Minute):
		t.Fatal("browser fixture timed out")
	}
}
