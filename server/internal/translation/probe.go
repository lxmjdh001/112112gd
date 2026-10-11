package translation

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Provider metadata is shared by the admin list and its fixed-address checks.
type Provider struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Endpoint string `json:"endpoint"`
}

var Providers = []Provider{
	{"google-free", "Google", "主用", "translate.googleapis.com"},
	{"mymemory", "MyMemory", "备用 1", "api.mymemory.translated.net"},
	{"libretranslate", "LibreTranslate", "备用 2", "translate.adminforge.de"},
}

func KnownProvider(id string) bool {
	for _, p := range Providers {
		if p.ID == id {
			return true
		}
	}
	return false
}

var (
	errRateLimited = errors.New("翻译接口限流")
	errNetwork     = errors.New("翻译连接失败")
	errUnavailable = errors.New("翻译服务暂不可用")
	errFormat      = errors.New("翻译返回格式异常")
)

type Check struct {
	Status    string    `json:"status"`
	LatencyMS int64     `json:"latencyMs"`
	CheckedAt time.Time `json:"checkedAt"`
}

// A check exercises exactly one provider, with fixed synthetic text. It does
// not use fallback, alter translation cooldowns, or enter customer usage totals.
func Probe(ctx context.Context, client *http.Client, provider string) (Check, error) {
	if !KnownProvider(provider) {
		return Check{}, errors.New("未知翻译接口")
	}
	work, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	start := time.Now()
	var e error
	switch provider {
	case "google-free":
		_, e = google(work, client, "Hello", "zh-CN")
	case "mymemory":
		_, e = myMemory(work, client, "Hello", "zh-CN", "en")
	case "libretranslate":
		_, e = libreTranslate(work, client, "Hello", "zh-CN", "en")
	}
	status := "available"
	if e != nil {
		switch {
		case errors.Is(e, errQuota):
			status = "quota"
		case errors.Is(e, errRateLimited):
			status = "limited"
		case errors.Is(e, context.DeadlineExceeded), errors.Is(work.Err(), context.DeadlineExceeded):
			status = "timeout"
		default:
			status = "unavailable"
		}
	}
	return Check{status, time.Since(start).Milliseconds(), time.Now().UTC()}, nil
}
