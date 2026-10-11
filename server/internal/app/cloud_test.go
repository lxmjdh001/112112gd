package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

const cloudSecret = "test-app-secret-0123456789"
const cloudToken = "test-cloud-access-token-0123456789"

type cloudHarness struct {
	*harness
	sent     atomic.Int32
	uploaded atomic.Int32
	failure  atomic.Int32
	payload  map[string]any
}

func setupCloud(t *testing.T) *cloudHarness {
	h := &cloudHarness{harness: setup(t)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "debug_token"):
			io.WriteString(w, `{"data":{"is_valid":true,"app_id":"100001","scopes":["whatsapp_business_messaging","whatsapp_business_management"]}}`)
		case strings.HasSuffix(r.URL.Path, "phone_numbers"):
			io.WriteString(w, `{"data":[{"id":"200001","display_phone_number":"+15550000001","verified_name":"客服一","quality_rating":"GREEN"},{"id":"200002","display_phone_number":"+15550000002","verified_name":"客服二","quality_rating":"GREEN"}]}`)
		case strings.HasSuffix(r.URL.Path, "message_templates"):
			io.WriteString(w, `{"data":[{"name":"welcome","language":"en_US","status":"APPROVED","components":[{"type":"BODY","text":"Hello {{1}}"}]},{"name":"plain","language":"en_US","status":"APPROVED","components":[{"type":"BODY","text":"Hello"}]},{"name":"unapproved","language":"en_US","status":"PENDING","components":[{"type":"BODY","text":"No"}]}]}`)
		case strings.HasSuffix(r.URL.Path, "subscribed_apps"):
			io.WriteString(w, `{"success":true}`)
		case strings.HasSuffix(r.URL.Path, "/media") && r.Method == "POST":
			if e := r.ParseMultipartForm(20 << 20); e != nil {
				t.Error(e)
			}
			fmt.Fprintf(w, `{"id":"%d"}`, 400000+h.uploaded.Add(1))
		case strings.HasSuffix(r.URL.Path, "/messages"):
			h.sent.Add(1)
			_ = json.NewDecoder(r.Body).Decode(&h.payload)
			failure := h.failure.Load()
			if failure != 0 {
				w.WriteHeader(int(failure))
				fmt.Fprint(w, `{"error":{"code":1,"message":"DO-NOT-EXPOSE-TOKEN"}}`)
				return
			}
			fmt.Fprintf(w, `{"messages":[{"id":"wamid.out.%d"}]}`, h.sent.Load())
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	h.app.Cloud.BaseURL = server.URL
	h.app.PublicURL = "https://gongdan.example"
	return h
}
func (h *cloudHarness) number(t *testing.T, phone string) string {
	t.Helper()
	return h.commerceCall(t, "POST", "/whatsapp-cloud/numbers", h.admin, gin.H{"label": "API 客服 " + phone, "appId": "100001", "appSecret": cloudSecret, "phoneId": phone, "wabaId": "300001", "token": cloudToken})["id"].(string)
}
func (h *cloudHarness) codeClient(t *testing.T) (string, string) {
	t.Helper()
	c := h.commerceCall(t, "POST", "/login-codes", h.admin, gin.H{"label": "API 使用者", "allowedPlatforms": []string{"whatsapp_cloud"}, "expiresAt": time.Now().Add(time.Hour)})
	_, d := h.login(c["code"].(string), "cloud-device")
	return c["id"].(string), d["data"].(map[string]any)["accessToken"].(string)
}
func (h *cloudHarness) callback(t *testing.T, number string) (string, string) {
	t.Helper()
	d := h.commerceCall(t, "POST", "/whatsapp-cloud/numbers/"+number+"/webhook", h.admin, gin.H{})
	return d["path"].(string), d["verifyToken"].(string)
}
func (h *cloudHarness) webhook(path string, body any, secret string) int {
	raw, _ := json.Marshal(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(raw)
	r := httptest.NewRequest("POST", path, bytes.NewReader(raw))
	r.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	w := httptest.NewRecorder()
	h.r.ServeHTTP(w, r)
	return w.Code
}
func inbound(phone, id, customer string, at time.Time) gin.H {
	return gin.H{"object": "whatsapp_business_account", "entry": []gin.H{{"id": "300001", "changes": []gin.H{{"field": "messages", "value": gin.H{"metadata": gin.H{"phone_number_id": phone}, "contacts": []gin.H{{"wa_id": customer, "profile": gin.H{"name": "客户 <script>"}}}, "messages": []gin.H{{"id": id, "from": customer, "timestamp": strconv.FormatInt(at.Unix(), 10), "type": "text", "text": gin.H{"body": "Hello <img src=x onerror=alert(1)>"}}}}}}}}}
}
func (h *cloudHarness) receive(t *testing.T, number, phone, meta, customer string, at time.Time) string {
	t.Helper()
	path, _ := h.callback(t, number)
	if s := h.webhook(path, inbound(phone, meta, customer, at), cloudSecret); s != 200 {
		t.Fatal("webhook", s)
	}
	_, d := h.call("GET", "/whatsapp-cloud/numbers/"+number+"/chats", h.admin, nil)
	return d["data"].([]any)[0].(map[string]any)["id"].(string)
}

func TestCloudOnboardingAssignmentsAndSecrets(t *testing.T) {
	h := setupCloud(t)
	number := h.number(t, "200001")
	otherNumber := h.number(t, "200002")
	path, verify := h.callback(t, number)
	otherPath, _ := h.callback(t, otherNumber)
	if path != otherPath {
		t.Fatal("same Meta app must share callback")
	}
	for _, valid := range []bool{false, true} {
		token := "wrong"
		expected := 403
		if valid {
			token = verify
			expected = 200
		}
		r := httptest.NewRequest("GET", path+"?hub.mode=subscribe&hub.challenge=challenge&hub.verify_token="+url.QueryEscape(token), nil)
		w := httptest.NewRecorder()
		h.r.ServeHTTP(w, r)
		if w.Code != expected || (valid && w.Body.String() != "challenge") {
			t.Fatal("verification failed", w.Code)
		}
	}
	_, d := h.call("GET", "/whatsapp-cloud/numbers", h.admin, nil)
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), cloudToken) || strings.Contains(string(raw), cloudSecret) || strings.Contains(string(raw), verify) {
		t.Fatal("secret exposed in list")
	}
	var cipher string
	if e := h.app.DB.QueryRow(context.Background(), `SELECT token_cipher FROM wa_cloud_numbers WHERE id=$1`, number).Scan(&cipher); e != nil || strings.Contains(cipher, cloudToken) {
		t.Fatal("token storage", e)
	}
	nativeCode, _ := h.code(t)
	if s, _ := h.call("PUT", "/whatsapp-cloud/numbers/"+number+"/assignments", h.admin, gin.H{"codeIds": []string{nativeCode}}); s != 400 {
		t.Fatal("ungranted code assigned", s)
	}
	code, client := h.codeClient(t)
	base := "/client/whatsapp-cloud/numbers/" + number
	if s, _ := h.call("GET", base+"/chats", client, nil); s != 404 {
		t.Fatal("unassigned number readable", s)
	}
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+number+"/assignments", h.admin, gin.H{"codeIds": []string{code}})
	if s, d := h.call("GET", base+"/chats", client, nil); s != 200 {
		t.Fatal(d)
	}
	_, d = h.call("GET", "/client/accounts", client, nil)
	if len(d["data"].([]any)) != 1 || d["data"].([]any)[0].(map[string]any)["connectionType"] != "cloud" {
		t.Fatal("client cloud account missing", d)
	}
	if s, _ := h.call("POST", "/client/accounts/"+number+"/open", client, gin.H{}); s != 404 {
		t.Fatal("cloud acquired native browser credentials", s)
	}
	if s, _ := h.call("POST", "/whatsapp-cloud/numbers/"+number+"/webhook", client, gin.H{}); s != 401 {
		t.Fatal("client could read verification secret")
	}
	h.commerceConfig(t)
	outsider := h.member(t, "cloud-outsider", "")
	if s, _ := h.call("GET", "/whatsapp-cloud/numbers/"+number+"/chats", outsider, nil); s != 404 {
		t.Fatal("cross-team read", s)
	}
	if s, _ := h.call("PUT", "/whatsapp-cloud/numbers/"+number+"/assignments", outsider, gin.H{"codeIds": []string{code}}); s != 404 {
		t.Fatal("cross-team assignment", s)
	}
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+number+"/assignments", h.admin, gin.H{"codeIds": []string{}})
	if s, _ := h.call("GET", base+"/chats", client, nil); s != 404 {
		t.Fatal("revocation ignored")
	}
}
func TestCloudWebhookDedupeBaselineAndWindow(t *testing.T) {
	h := setupCloud(t)
	n := h.number(t, "200001")
	n2 := h.number(t, "200002")
	path, _ := h.callback(t, n)
	event := inbound("200001", "wamid.in.1", "15550001111", time.Now())
	if s := h.webhook(path, event, "wrong"); s != 403 {
		t.Fatal("unsigned accepted")
	}
	var wg sync.WaitGroup
	results := make(chan int, 8)
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); results <- h.webhook(path, event, cloudSecret) }()
	}
	wg.Wait()
	close(results)
	for s := range results {
		if s != 200 {
			t.Fatal("concurrent delivery", s)
		}
	}
	var count, unread int
	var customerIP string
	if e := h.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM wa_cloud_messages`).Scan(&count); e != nil || count != 1 {
		t.Fatal("duplicate inbound", count, e)
	}
	h.app.DB.QueryRow(context.Background(), `SELECT unread FROM wa_cloud_chats WHERE number_id=$1`, n).Scan(&unread)
	if unread != 1 {
		t.Fatal("duplicate unread", unread)
	}
	h.app.DB.QueryRow(context.Background(), `SELECT customer_ip FROM customer_conversations WHERE account_id=$1`, n).Scan(&customerIP)
	if customerIP != "" {
		t.Fatal("fabricated customer IP")
	}
	chat := h.receive(t, n2, "200002", "wamid.in.2", "15550001111", time.Now().Add(-25*time.Hour))
	var dup bool
	h.app.DB.QueryRow(context.Background(), `SELECT duplicate_account FROM customer_conversations WHERE account_id=$1`, n2).Scan(&dup)
	if !dup {
		t.Fatal("cross-account WhatsApp duplicate not detected")
	}
	base := "/whatsapp-cloud/numbers/" + n2
	if s, _ := h.call("POST", base+"/chats/"+chat+"/messages", h.admin, gin.H{"kind": "text", "text": "outside", "requestId": key(12001)}); s != 409 {
		t.Fatal("outside service window accepted", s)
	}
	h.commerceCall(t, "POST", base+"/templates/sync", h.admin, gin.H{})
	if s, _ := h.call("POST", base+"/chats/"+chat+"/messages", h.admin, gin.H{"kind": "template", "templateName": "welcome", "language": "en_US", "requestId": key(12002)}); s != 400 {
		t.Fatal("missing template parameters accepted", s)
	}
	h.commerceCall(t, "POST", base+"/chats/"+chat+"/messages", h.admin, gin.H{"kind": "template", "templateName": "welcome", "language": "en_US", "parameters": []string{"Customer"}, "requestId": key(12003)})
	if worked, e := h.app.processCloudSend(context.Background()); !worked || e != nil {
		t.Fatal(worked, e)
	}
	if h.sent.Load() != 1 || h.payload["type"] != "template" {
		t.Fatal("template not sent")
	}
}
func TestCloudOutboxIdempotencyReceiptsAndUnknown(t *testing.T) {
	h := setupCloud(t)
	n := h.number(t, "200001")
	chat := h.receive(t, n, "200001", "wamid.in.1", "15550001111", time.Now())
	base := "/whatsapp-cloud/numbers/" + n
	body := gin.H{"kind": "text", "text": "reply", "requestId": key(12101)}
	first := h.commerceCall(t, "POST", base+"/chats/"+chat+"/messages", h.admin, body)
	again := h.commerceCall(t, "POST", base+"/chats/"+chat+"/messages", h.admin, body)
	if first["id"] != again["id"] {
		t.Fatal("request duplicated")
	}
	changed := gin.H{"kind": "text", "text": "different", "requestId": key(12101)}
	if s, _ := h.call("POST", base+"/chats/"+chat+"/messages", h.admin, changed); s != 409 {
		t.Fatal("request key reused")
	}
	if _, e := h.app.processCloudSend(context.Background()); e != nil {
		t.Fatal(e)
	}
	if worked, e := h.app.processCloudSend(context.Background()); worked || e != nil {
		t.Fatal("sent twice", worked, e)
	}
	path, _ := h.callback(t, n)
	for _, state := range []string{"read", "sent", "delivered", "failed"} {
		receipt := gin.H{"object": "whatsapp_business_account", "entry": []gin.H{{"id": "300001", "changes": []gin.H{{"field": "messages", "value": gin.H{"metadata": gin.H{"phone_number_id": "200001"}, "statuses": []gin.H{{"id": "wamid.out.1", "status": state, "recipient_id": "15550001111", "timestamp": strconv.FormatInt(time.Now().Unix(), 10), "biz_opaque_callback_data": key(12101)}}}}}}}}
		if s := h.webhook(path, receipt, cloudSecret); s != 200 {
			t.Fatal(s)
		}
	}
	var status string
	h.app.DB.QueryRow(context.Background(), `SELECT status FROM wa_cloud_messages WHERE id=$1`, first["id"]).Scan(&status)
	if status != "read" {
		t.Fatal("receipt regressed", status)
	}
	h.failure.Store(500)
	second := h.commerceCall(t, "POST", base+"/chats/"+chat+"/messages", h.admin, gin.H{"kind": "text", "text": "uncertain", "requestId": key(12102)})
	if _, e := h.app.processCloudSend(context.Background()); e != nil {
		t.Fatal(e)
	}
	h.app.DB.QueryRow(context.Background(), `SELECT status FROM wa_cloud_messages WHERE id=$1`, second["id"]).Scan(&status)
	if status != "unknown" {
		t.Fatal("uncertain send not retained", status)
	}
	if worked, _ := h.app.processCloudSend(context.Background()); worked {
		t.Fatal("uncertain message automatically retried")
	}
}
func TestCloudQueuedSendHonorsRevocation(t *testing.T) {
	h := setupCloud(t)
	n := h.number(t, "200001")
	chat := h.receive(t, n, "200001", "wamid.in.1", "15550001111", time.Now())
	code, client := h.codeClient(t)
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+n+"/assignments", h.admin, gin.H{"codeIds": []string{code}})
	h.commerceCall(t, "POST", "/client/whatsapp-cloud/numbers/"+n+"/chats/"+chat+"/messages", client, gin.H{"kind": "text", "text": "must not send", "requestId": key(12201)})
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+n+"/assignments", h.admin, gin.H{"codeIds": []string{}})
	if _, e := h.app.processCloudSend(context.Background()); e != nil {
		t.Fatal(e)
	}
	if h.sent.Load() != 0 {
		t.Fatal("revoked user sent queued message")
	}
}

type cloudTranslationTransport func(*http.Request) (*http.Response, error)

func (f cloudTranslationTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestCloudTranslationCountsAndFailure(t *testing.T) {
	h := setupCloud(t)
	n := h.number(t, "200001")
	calls := 0
	h.app.TranslationHTTP = &http.Client{Transport: cloudTranslationTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Scheme != "https" || r.URL.Host != "translate.googleapis.com" || r.Header.Get("Authorization") != "" || r.URL.Query().Get("q") != "你好 & 世界" {
			t.Error("unexpected translation request")
		}
		status := 200
		body := `[[["Hello ","你好",null,null],["world!","世界",null,null]],null,"zh-CN"]`
		if calls == 2 {
			status = 429
			body = "private upstream failure"
		}
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	route := "/whatsapp-cloud/numbers/" + n + "/translate"
	b := gin.H{"text": "你好 & 世界", "target": "en"}
	if out := h.commerceCall(t, "POST", route, h.admin, b); out["text"] != "Hello world!" {
		t.Fatal(out)
	}
	if status, out := h.call("POST", route, h.admin, b); status != 502 || strings.Contains(out["message"].(string), "private") {
		t.Fatal(status, out)
	}
	if status, _ := h.call("POST", route, h.admin, gin.H{"text": "test", "target": "unsupported"}); status != 400 {
		t.Fatal(status)
	}
	var count, input, output int
	if e := h.app.DB.QueryRow(context.Background(), `SELECT count(*),sum(input_chars),sum(output_chars) FROM usage_records WHERE account_id=$1`, n).Scan(&count, &input, &output); e != nil || count != 1 || input != 7 || output != 12 {
		t.Fatal(count, input, output, e)
	}
	if calls != 2 {
		t.Fatal("validation contacted Google")
	}
}

func TestCloudQueuedSendHonorsDeviceRevocation(t *testing.T) {
	h := setupCloud(t)
	n := h.number(t, "200001")
	chat := h.receive(t, n, "200001", "wamid.device", "15550001111", time.Now())
	code, client := h.codeClient(t)
	h.commerceCall(t, "PUT", "/whatsapp-cloud/numbers/"+n+"/assignments", h.admin, gin.H{"codeIds": []string{code}})
	h.commerceCall(t, "POST", "/client/whatsapp-cloud/numbers/"+n+"/chats/"+chat+"/messages", client, gin.H{"kind": "text", "text": "must not send after device removal", "requestId": key(12211)})
	if _, e := h.app.DB.Exec(context.Background(), `UPDATE devices SET active=false WHERE code_id=$1`, code); e != nil {
		t.Fatal(e)
	}
	if _, e := h.app.processCloudSend(context.Background()); e != nil {
		t.Fatal(e)
	}
	if h.sent.Load() != 0 {
		t.Fatal("revoked device sent queued message")
	}
}
