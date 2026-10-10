// Package whatsappcloud is a small, independently implemented Cloud API adapter.
// Structure informed by github.com/piusalfred/whatsapp; no SDK dependency.
package whatsappcloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const MaxMedia = 16 << 20

var NumericID = regexp.MustCompile(`^[0-9]{5,40}$`)
var Version = regexp.MustCompile(`^v[0-9]{2,3}\.0$`)

type Client struct {
	HTTP             *http.Client
	BaseURL, Version string
}

func New(version string) *Client {
	if !Version.MatchString(version) {
		version = "v25.0"
	}
	return &Client{HTTP: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, BaseURL: "https://graph.facebook.com", Version: version}
}

type APIError struct{ Code, Subcode, HTTPStatus int }

func (e *APIError) Error() string {
	switch e.Code {
	case 190:
		return "Meta 授权已失效，请更新访问令牌"
	case 10, 200:
		return "Meta 权限不足，请检查应用和号码授权"
	case 131047:
		return "已超出 24 小时客服窗口，请使用获批模板"
	case 130429, 131056:
		return "Meta 暂时限流，请稍后再试"
	}
	return fmt.Sprintf("Meta 请求失败（HTTP %d，错误码 %d/%d）", e.HTTPStatus, e.Code, e.Subcode)
}
func (c *Client) do(ctx context.Context, method, path, token string, query url.Values, body any, out any) error {
	var reader io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		reader = bytes.NewReader(b)
	}
	u := c.BaseURL + "/" + c.Version + "/" + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, e := http.NewRequestWithContext(ctx, method, u, reader)
	if e != nil {
		return errors.New("Meta 请求参数无效")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, e := c.HTTP.Do(req)
	if e != nil {
		return errors.New("Meta 连接失败或超时")
	}
	defer res.Body.Close()
	return decode(res, out)
}
func decode(res *http.Response, out any) error {
	data, e := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if e != nil {
		return errors.New("Meta 响应读取失败")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var v struct {
			Error struct {
				Code    int `json:"code"`
				Subcode int `json:"error_subcode"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &v)
		return &APIError{v.Error.Code, v.Error.Subcode, res.StatusCode}
	}
	if out != nil && json.Unmarshal(data, out) != nil {
		return errors.New("Meta 返回格式异常")
	}
	return nil
}

type Number struct {
	ID           string `json:"id"`
	DisplayPhone string `json:"display_phone_number"`
	Name         string `json:"verified_name"`
	Quality      string `json:"quality_rating"`
}

func (c *Client) Validate(ctx context.Context, appID, secret, token, wabaID, phoneID string) (Number, error) {
	var debug struct {
		Data struct {
			Valid  bool     `json:"is_valid"`
			AppID  string   `json:"app_id"`
			Scopes []string `json:"scopes"`
		} `json:"data"`
	}
	if e := c.do(ctx, "GET", "debug_token", appID+"|"+secret, url.Values{"input_token": {token}}, nil, &debug); e != nil {
		return Number{}, e
	}
	permissions := map[string]bool{}
	for _, s := range debug.Data.Scopes {
		permissions[s] = true
	}
	if !debug.Data.Valid || debug.Data.AppID != appID || !permissions["whatsapp_business_messaging"] || !permissions["whatsapp_business_management"] {
		return Number{}, errors.New("令牌无效、应用不匹配或缺少 WhatsApp 管理/消息权限")
	}
	after := ""
	for page := 0; page < 100; page++ {
		var list struct {
			Data   []Number `json:"data"`
			Paging struct {
				Next    string `json:"next"`
				Cursors struct {
					After string `json:"after"`
				} `json:"cursors"`
			} `json:"paging"`
		}
		q := url.Values{"fields": {"id,display_phone_number,verified_name,quality_rating"}, "limit": {"100"}}
		if after != "" {
			q.Set("after", after)
		}
		if e := c.do(ctx, "GET", wabaID+"/phone_numbers", token, q, nil, &list); e != nil {
			return Number{}, e
		}
		for _, n := range list.Data {
			if n.ID == phoneID {
				return n, nil
			}
		}
		if list.Paging.Next == "" || list.Paging.Cursors.After == "" || list.Paging.Cursors.After == after {
			break
		}
		after = list.Paging.Cursors.After
	}
	return Number{}, errors.New("此号码 ID 不属于填写的 WABA，或令牌无权访问")
}
func (c *Client) Subscribe(ctx context.Context, token, waba string) error {
	var v struct {
		Success bool `json:"success"`
	}
	if e := c.do(ctx, "POST", waba+"/subscribed_apps", token, nil, map[string]any{}, &v); e != nil {
		return e
	}
	if !v.Success {
		return errors.New("Meta 未确认订阅成功")
	}
	return nil
}
func (c *Client) Send(ctx context.Context, token, phone string, payload json.RawMessage) (string, error) {
	var v struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if e := c.do(ctx, "POST", phone+"/messages", token, nil, payload, &v); e != nil {
		return "", e
	}
	if len(v.Messages) == 0 || v.Messages[0].ID == "" {
		return "", errors.New("Meta 未返回消息 ID，请核实后再发送")
	}
	return v.Messages[0].ID, nil
}

type Template struct {
	ID              string      `json:"id"`
	Name            string      `json:"name"`
	Language        string      `json:"language"`
	Status          string      `json:"status"`
	Category        string      `json:"category"`
	ParameterFormat string      `json:"parameter_format"`
	Components      []Component `json:"components"`
}
type Component struct {
	Type    string            `json:"type"`
	Format  string            `json:"format"`
	Text    string            `json:"text"`
	Buttons []json.RawMessage `json:"buttons"`
}

func (c *Client) Templates(ctx context.Context, token, waba string) ([]Template, error) {
	out := []Template{}
	after := ""
	for page := 0; page < 20; page++ {
		var v struct {
			Data   []Template `json:"data"`
			Paging struct {
				Next    string `json:"next"`
				Cursors struct {
					After string `json:"after"`
				} `json:"cursors"`
			} `json:"paging"`
		}
		q := url.Values{"fields": {"id,name,language,status,category,components,parameter_format"}, "limit": {"100"}}
		if after != "" {
			q.Set("after", after)
		}
		if e := c.do(ctx, "GET", waba+"/message_templates", token, q, nil, &v); e != nil {
			return nil, e
		}
		out = append(out, v.Data...)
		if v.Paging.Next == "" {
			return out, nil
		}
		if v.Paging.Cursors.After == "" || after == v.Paging.Cursors.After {
			return nil, errors.New("模板分页返回异常")
		}
		after = v.Paging.Cursors.After
	}
	return nil, errors.New("模板数量超过单次同步上限")
}
func (c *Client) Upload(ctx context.Context, token, phone, mime, filename string, data []byte) (string, error) {
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	_ = w.WriteField("messaging_product", "whatsapp")
	_ = w.WriteField("type", mime)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, strings.NewReplacer(`"`, "_", "\r", "_", "\n", "_").Replace(filename)))
	h.Set("Content-Type", mime)
	f, e := w.CreatePart(h)
	if e != nil {
		return "", e
	}
	_, _ = f.Write(data)
	_ = w.Close()
	req, e := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/"+c.Version+"/"+phone+"/media", &b)
	if e != nil {
		return "", e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", w.FormDataContentType())
	res, e := c.HTTP.Do(req)
	if e != nil {
		return "", errors.New("媒体上传失败或超时")
	}
	defer res.Body.Close()
	var v struct {
		ID string `json:"id"`
	}
	if e = decode(res, &v); e != nil {
		return "", e
	}
	if v.ID == "" {
		return "", errors.New("Meta 未返回媒体 ID")
	}
	return v.ID, nil
}
func (c *Client) Download(ctx context.Context, token, mediaID string) ([]byte, string, error) {
	var v struct {
		URL  string `json:"url"`
		Mime string `json:"mime_type"`
		Size int64  `json:"file_size"`
	}
	if e := c.do(ctx, "GET", mediaID, token, nil, nil, &v); e != nil {
		return nil, "", e
	}
	u, e := url.Parse(v.URL)
	if e != nil || u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") || !(u.Hostname() == "lookaside.fbsbx.com" || strings.HasSuffix(u.Hostname(), ".fbcdn.net")) || v.Size > MaxMedia {
		return nil, "", errors.New("媒体地址或大小不受支持")
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, e := c.HTTP.Do(req)
	if e != nil {
		return nil, "", errors.New("媒体下载失败")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, "", errors.New("媒体已过期或暂不可下载")
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, MaxMedia+1))
	if e != nil || len(data) > MaxMedia {
		return nil, "", errors.New("媒体超过 16 MB 或下载失败")
	}
	return data, v.Mime, nil
}
