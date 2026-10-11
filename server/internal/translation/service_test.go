package translation

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(v any) *http.Response {
	b, _ := json.Marshal(v)
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(b))), Header: http.Header{}}
}
func TestFailoverCacheAndCooldown(t *testing.T) {
	var s Service
	var google, memory atomic.Int32
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "" {
			t.Error("credential sent to provider")
		}
		if r.URL.Host == "translate.googleapis.com" {
			google.Add(1)
			res := response(nil)
			res.StatusCode = 429
			return res, nil
		}
		memory.Add(1)
		if r.URL.Host != "api.mymemory.translated.net" || r.URL.Query().Get("langpair") != "zh-CN|pt" {
			t.Errorf("unexpected provider or language")
		}
		if len(r.URL.Query().Get("q")) > 500 {
			t.Error("chunk exceeded provider byte limit")
		}
		return response(map[string]any{"responseStatus": 200, "responseData": map[string]string{"translatedText": "Olá"}}), nil
	})}
	for _, text := range []string{"你好", "你好", "谢谢"} {
		result, e := s.Translate(context.Background(), client, "account", text, "pt", "zh-CN")
		if e != nil || result.Text != "Olá" || result.Provider != "mymemory" {
			t.Fatal(result, e)
		}
	}
	if google.Load() != 1 || memory.Load() != 2 {
		t.Fatal(google.Load(), memory.Load())
	}
}
func TestSplitUnicodeAndQuotaFailure(t *testing.T) {
	text := strings.TrimSpace(strings.Repeat("你好🌍这是一个长句。\n", 60))
	var combined strings.Builder
	for _, part := range split(text) {
		if len(part.text) > 500 {
			t.Fatal("oversize")
		}
		combined.WriteString(part.text + part.separator)
	}
	if combined.String() != text {
		t.Fatal("lost text or paragraph spacing")
	}
	var s Service
	calls := 0
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host == "translate.googleapis.com" {
			res := response(nil)
			res.StatusCode = 429
			return res, nil
		}
		return response(map[string]any{"responseStatus": 429, "quotaFinished": true, "responseData": map[string]string{"translatedText": "MYMEMORY WARNING"}}), nil
	})}
	for _, text := range []string{"你好", "谢谢"} {
		if result, e := s.Translate(context.Background(), client, "account", text, "en", "zh-CN"); e == nil || result.Text != "" {
			t.Fatal(result, e)
		}
	}
	if calls != 3 {
		t.Fatal("provider hammered during cooldown", calls)
	}
}

func TestLibreTranslateFailoverAndChunks(t *testing.T) {
	var s Service
	var hosts []string
	var inputs []string
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		hosts = append(hosts, r.URL.Host)
		if r.URL.Host != "translate.adminforge.de" {
			res := response(nil)
			res.StatusCode = 429
			return res, nil
		}
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > 10*time.Second {
			t.Fatal("unbounded fallback request")
		}
		if r.Method != "POST" || r.URL.Path != "/translate" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Authorization") != "" {
			t.Fatal("invalid or credential-bearing POST")
		}
		var payload map[string]string
		if e := json.NewDecoder(r.Body).Decode(&payload); e != nil {
			t.Fatal(e)
		}
		if payload["source"] != "zh-Hant" || payload["target"] != "zh-Hans" || payload["format"] != "text" || utf8.RuneCountInString(payload["q"]) > 1000 {
			t.Fatal("invalid language or chunk size")
		}
		inputs = append(inputs, payload["q"])
		return response(map[string]string{"translatedText": payload["q"]}), nil
	})}
	text := strings.TrimSpace(strings.Repeat("請報價🌍，謝謝。\n", 160))
	for i := range 2 {
		result, e := s.Translate(context.Background(), client, "account", text, "zh-CN", "zh-TW")
		if e != nil || result.Text != text || result.Provider != "libretranslate" || result.Cached != (i == 1) {
			t.Fatal(result, e)
		}
	}
	if len(inputs) < 2 || len(hosts) != len(inputs)+2 || hosts[0] != "translate.googleapis.com" || hosts[1] != "api.mymemory.translated.net" {
		t.Fatal("unexpected chain or cache failure", hosts)
	}
}

func TestLibreTranslateAutoSourceAndPartialFailure(t *testing.T) {
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		var payload map[string]string
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["source"] != "auto" {
			t.Fatal("missing source should use auto detection")
		}
		return response(map[string]any{"translatedText": "你好", "detectedLanguage": map[string]string{"language": "zh-Hans"}}), nil
	})}
	result, e := libreTranslate(context.Background(), client, "123", "zh-CN", "")
	if e != nil || result.Source != "zh-CN" {
		t.Fatal(result, e)
	}
	calls := 0
	client.Transport = transport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return response(map[string]string{"translatedText": "first chunk only"}), nil
		}
		return response(map[string]string{"error": "private upstream error", "translatedText": "do not send"}), nil
	})
	result, e = libreTranslate(context.Background(), client, strings.Repeat("你好。", 500), "en", "zh-CN")
	if e == nil || result.Text != "" || strings.Contains(e.Error(), "private") {
		t.Fatal("partial or error response escaped", result, e)
	}
}
func TestCoalescingAndTenantSeparation(t *testing.T) {
	var s Service
	var calls atomic.Int32
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		time.Sleep(10 * time.Millisecond)
		return response([]any{[][]string{{"你好"}}, nil, "en"}), nil
	})}
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := s.Translate(context.Background(), client, "tenant1", "Hello", "zh-CN", "en"); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
	if _, e := s.Translate(context.Background(), client, "tenant2", "Hello", "zh-CN", "en"); e != nil {
		t.Fatal(e)
	}
	if calls.Load() != 2 {
		t.Fatal("tenant cache unexpectedly shared")
	}
}
