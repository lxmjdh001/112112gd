// Package translation provides free translation failover. Text stays in bounded
// memory caches and is never logged; providers receive only translation requests.
package translation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

var Languages = map[string]bool{"zh-CN": true, "zh-TW": true, "en": true, "es": true, "pt": true, "ar": true, "ru": true, "fr": true, "de": true, "ja": true, "ko": true, "vi": true, "th": true, "id": true, "hi": true}

type Result struct {
	Text     string `json:"text"`
	Source   string `json:"sourceLanguage"`
	Target   string `json:"targetLanguage"`
	Provider string `json:"provider"`
	Cached   bool   `json:"-"`
}
type entry struct {
	at     time.Time
	result Result
}
type pending struct {
	done   chan struct{}
	result Result
	err    error
}
type Service struct {
	mu     sync.Mutex
	paused map[string]time.Time
	cache  map[string]entry
	jobs   map[string]*pending
}

func (s *Service) Translate(ctx context.Context, client *http.Client, scope, text, target, source string) (Result, error) {
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > 4000 || !Languages[target] || (source != "" && !Languages[source]) {
		return Result{}, errors.New("翻译参数无效")
	}
	key := scope + "\x00" + target + "\x00" + source + "\x00" + text
	s.mu.Lock()
	if s.cache == nil {
		s.cache = map[string]entry{}
		s.jobs = map[string]*pending{}
		s.paused = map[string]time.Time{}
	}
	if saved, ok := s.cache[key]; ok && time.Since(saved.at) < 5*time.Minute {
		s.mu.Unlock()
		saved.result.Cached = true
		return saved.result, nil
	}
	if job := s.jobs[key]; job != nil {
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return Result{}, ctx.Err()
		case <-job.done:
			r := job.result
			r.Cached = true
			return r, job.err
		}
	}
	job := &pending{done: make(chan struct{})}
	s.jobs[key] = job
	s.mu.Unlock()
	r, e := s.request(ctx, client, text, target, source)
	s.mu.Lock()
	defer s.mu.Unlock()
	if e == nil {
		if len(s.cache) >= 500 {
			var oldest string
			var at time.Time
			for k, v := range s.cache {
				if at.IsZero() || v.at.Before(at) {
					oldest = k
					at = v.at
				}
			}
			delete(s.cache, oldest)
		}
		s.cache[key] = entry{time.Now(), r}
	}
	job.result = r
	job.err = e
	delete(s.jobs, key)
	close(job.done)
	return r, e
}
func (s *Service) request(ctx context.Context, client *http.Client, text, target, source string) (Result, error) {
	// The complete fallback chain stays below the client's 30-second timeout.
	for _, provider := range []string{"google-free", "mymemory", "libretranslate"} {
		s.mu.Lock()
		paused := time.Now().Before(s.paused[provider])
		s.mu.Unlock()
		if paused {
			continue
		}
		timeout := 5 * time.Second
		if provider != "google-free" {
			timeout = 10 * time.Second
		}
		work, cancel := context.WithTimeout(ctx, timeout)
		var r Result
		var e error
		cooldown := time.Minute
		if provider == "google-free" {
			r, e = google(work, client, text, target)
		} else if provider == "mymemory" {
			r, e = myMemory(work, client, text, target, source)
			if errors.Is(e, errQuota) {
				cooldown = time.Hour
			}
		} else {
			r, e = libreTranslate(work, client, text, target, source)
		}
		cancel()
		if e == nil {
			return r, nil
		}
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		s.mu.Lock()
		s.paused[provider] = time.Now().Add(cooldown)
		s.mu.Unlock()
	}
	return Result{}, errors.New("翻译服务暂时限流、额度用完或连接失败。翻译未完成，请稍后重试")
}
func fetch(ctx context.Context, client *http.Client, address string, out any, payload ...any) error {
	method := http.MethodGet
	var body io.Reader
	if len(payload) > 0 {
		encoded, e := json.Marshal(payload[0])
		if e != nil {
			return e
		}
		method = http.MethodPost
		body = bytes.NewReader(encoded)
	}
	req, e := http.NewRequestWithContext(ctx, method, address, body)
	if e != nil {
		return e
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Cache-Control", "no-store")
	res, e := client.Do(req)
	if e != nil {
		return errors.New("翻译连接失败")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return errors.New("翻译服务暂不可用")
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out)
}
func google(ctx context.Context, client *http.Client, text, target string) (Result, error) {
	q := url.Values{"client": {"gtx"}, "sl": {"auto"}, "tl": {target}, "dt": {"t"}, "q": {text}}
	var data []json.RawMessage
	if e := fetch(ctx, client, "https://translate.googleapis.com/translate_a/single?"+q.Encode(), &data); e != nil {
		return Result{}, e
	}
	if len(data) == 0 {
		return Result{}, errors.New("翻译格式异常")
	}
	var parts [][]json.RawMessage
	if json.Unmarshal(data[0], &parts) != nil {
		return Result{}, errors.New("翻译格式异常")
	}
	var out strings.Builder
	for _, p := range parts {
		if len(p) > 0 {
			var t string
			_ = json.Unmarshal(p[0], &t)
			out.WriteString(t)
		}
	}
	var source string
	if len(data) > 2 {
		_ = json.Unmarshal(data[2], &source)
	}
	return checked(out.String(), source, target, "google-free")
}

var errQuota = errors.New("MyMemory 免费额度已用完")

func myMemory(ctx context.Context, client *http.Client, text, target, source string) (Result, error) {
	if source == "" {
		for _, r := range text {
			if unicode.Is(unicode.Han, r) {
				source = "zh-CN"
				break
			}
		}
	}
	if source == "" {
		return Result{}, errors.New("请设置客户语言后重试")
	}
	if source == target {
		return checked(text, source, target, "original")
	}
	var out strings.Builder
	for _, part := range split(text) {
		q := url.Values{"q": {part.text}, "langpair": {source + "|" + target}, "mt": {"1"}}
		var body struct {
			Status json.RawMessage `json:"responseStatus"`
			Quota  bool            `json:"quotaFinished"`
			Data   struct {
				Text string `json:"translatedText"`
			} `json:"responseData"`
		}
		if e := fetch(ctx, client, "https://api.mymemory.translated.net/get?"+q.Encode(), &body); e != nil {
			return Result{}, e
		}
		status := strings.Trim(string(body.Status), "\"")
		if body.Quota || status == "429" {
			return Result{}, errQuota
		}
		if status != "200" || strings.TrimSpace(body.Data.Text) == "" {
			return Result{}, errors.New("MyMemory 未返回有效译文")
		}
		out.WriteString(strings.TrimSpace(body.Data.Text))
		out.WriteString(part.separator)
	}
	return checked(out.String(), source, target, "mymemory")
}

func libreTranslate(ctx context.Context, client *http.Client, text, target, source string) (Result, error) {
	var out strings.Builder
	detected := source
	from := source
	if from == "" {
		from = "auto"
	}
	// Keep chunks below the public instance’s 10,000-character request limit.
	for _, part := range splitLimited(text, len(text), 1000) {
		var body struct {
			Text     string `json:"translatedText"`
			Error    string `json:"error"`
			Detected struct {
				Language string `json:"language"`
			} `json:"detectedLanguage"`
		}
		payload := map[string]string{"q": part.text, "source": libreLanguage(from), "target": libreLanguage(target), "format": "text"}
		if e := fetch(ctx, client, "https://translate.adminforge.de/translate", &body, payload); e != nil {
			return Result{}, e
		}
		if body.Error != "" || strings.TrimSpace(body.Text) == "" {
			return Result{}, errors.New("未获得有效译文")
		}
		out.WriteString(strings.TrimSpace(body.Text))
		out.WriteString(part.separator)
		if detected == "" {
			detected = body.Detected.Language
			if detected == "zh-Hans" {
				detected = "zh-CN"
			}
			if detected == "zh-Hant" {
				detected = "zh-TW"
			}
		}
	}
	return checked(out.String(), detected, target, "libretranslate")
}

func libreLanguage(language string) string {
	switch language {
	case "zh-CN":
		return "zh-Hans"
	case "zh-TW":
		return "zh-Hant"
	default:
		return language
	}
}
func checked(text, source, target, provider string) (Result, error) {
	if strings.TrimSpace(text) == "" || utf8.RuneCountInString(text) > 32000 {
		return Result{}, errors.New("未获得有效译文")
	}
	return Result{Text: text, Source: source, Target: target, Provider: provider}, nil
}

type chunk struct{ text, separator string }

func split(text string) []chunk {
	return splitLimited(text, 500, 4000)
}
func splitLimited(text string, maxBytes, maxChars int) []chunk {
	var parts []chunk
	rest := strings.TrimSpace(text)
	for rest != "" {
		end, boundary, chars := 0, 0, 0
		for pos, r := range rest {
			n := utf8.RuneLen(r)
			if pos+n > maxBytes || chars >= maxChars {
				break
			}
			end = pos + n
			chars++
			if unicode.IsSpace(r) || strings.ContainsRune("。！？.!?", r) {
				boundary = end
			}
		}
		if end < len(rest) && boundary > end/2 {
			end = boundary
		}
		piece := rest[:end]
		rest = rest[end:]
		separator := piece[len(strings.TrimRightFunc(piece, unicode.IsSpace)):]
		if separator == "" {
			separator = rest[:len(rest)-len(strings.TrimLeftFunc(rest, unicode.IsSpace))]
		}
		rest = strings.TrimSpace(rest)
		if rest == "" {
			separator = ""
		} else if separator == "" {
			separator = " "
		}
		parts = append(parts, chunk{strings.TrimSpace(piece), separator})
	}
	return parts
}
