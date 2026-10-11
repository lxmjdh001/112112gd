// Package translation provides free translation failover. Text stays in bounded
// memory caches and is never logged; providers receive only translation requests.
package translation

import (
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
	for _, provider := range []string{"google-free", "mymemory"} {
		s.mu.Lock()
		paused := time.Now().Before(s.paused[provider])
		s.mu.Unlock()
		if paused {
			continue
		}
		timeout := 5 * time.Second
		if provider == "mymemory" {
			timeout = 20 * time.Second
		}
		work, cancel := context.WithTimeout(ctx, timeout)
		var r Result
		var e error
		cooldown := time.Minute
		if provider == "google-free" {
			r, e = google(work, client, text, target)
		} else {
			r, e = myMemory(work, client, text, target, source)
			if errors.Is(e, errQuota) {
				cooldown = time.Hour
			}
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
	return Result{}, errors.New("Google 暂时限流或连接失败；MyMemory 额度用完、语言未识别或连接失败。翻译未完成，请稍后重试")
}
func fetch(ctx context.Context, client *http.Client, address string, out any) error {
	req, e := http.NewRequestWithContext(ctx, "GET", address, nil)
	if e != nil {
		return e
	}
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
func checked(text, source, target, provider string) (Result, error) {
	if strings.TrimSpace(text) == "" || utf8.RuneCountInString(text) > 32000 {
		return Result{}, errors.New("未获得有效译文")
	}
	return Result{Text: text, Source: source, Target: target, Provider: provider}, nil
}

type chunk struct{ text, separator string }

func split(text string) []chunk {
	var parts []chunk
	rest := strings.TrimSpace(text)
	for rest != "" {
		end, boundary := 0, 0
		for pos, r := range rest {
			n := utf8.RuneLen(r)
			if pos+n > 500 {
				break
			}
			end = pos + n
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
