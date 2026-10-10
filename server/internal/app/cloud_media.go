package app

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gongdan007/server/internal/whatsappcloud"
)

func mediaKind(mime string) string {
	switch mime {
	case "image/jpeg", "image/png":
		return "image"
	case "audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg":
		return "audio"
	case "video/mp4", "video/3gpp":
		return "video"
	case "application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation":
		return "document"
	}
	return ""
}
func (a *App) cloudUpload(c *gin.Context) {
	var b struct {
		Data     string `json:"data"`
		Mime     string `json:"mime"`
		Filename string `json:"filename"`
	}
	if c.ShouldBindJSON(&b) != nil || len(b.Data) > (whatsappcloud.MaxMedia+2)/3*4 || mediaKind(b.Mime) == "" || len(b.Filename) > 200 {
		fail(c, 400, "支持图片、音视频、PDF 和办公文档，文件最多 16 MB")
		return
	}
	data, e := base64.StdEncoding.DecodeString(b.Data)
	if e != nil || len(data) == 0 || len(data) > whatsappcloud.MaxMedia || (mediaKind(b.Mime) == "image" && len(data) > 5<<20) {
		fail(c, 400, "文件格式或大小无效，图片最多 5 MB，其他文件最多 16 MB")
		return
	}
	if mediaKind(b.Mime) == "image" && http.DetectContentType(data) != b.Mime {
		fail(c, 400, "图片内容与类型不匹配")
		return
	}
	filename := strings.ReplaceAll(filepath.Base(b.Filename), "\x00", "")
	if filename == "" || filename == "." {
		filename = "attachment"
	}
	n, e := a.cloudNumber(c.Request.Context(), identity(c).Tenant, c.Param("number"))
	if e != nil {
		commerceFail(c, e)
		return
	}
	if !n.Enabled {
		fail(c, 409, "API 号码已停用")
		return
	}
	meta, e := a.Cloud.Upload(c.Request.Context(), n.Token, n.PhoneID, b.Mime, filename, data)
	if e != nil {
		fail(c, 502, e.Error())
		return
	}
	var id string
	e = a.DB.QueryRow(c.Request.Context(), `INSERT INTO wa_cloud_media(tenant_id,number_id,meta_id,mime,filename,size) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`, n.Tenant, n.ID, meta, b.Mime, filename, len(data)).Scan(&id)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"id": id, "kind": mediaKind(b.Mime), "filename": filename})
}
func (a *App) cloudDownload(c *gin.Context) {
	n, e := a.cloudNumber(c.Request.Context(), identity(c).Tenant, c.Param("number"))
	if e != nil {
		commerceFail(c, e)
		return
	}
	var meta, filename string
	e = a.DB.QueryRow(c.Request.Context(), `SELECT meta_id,filename FROM wa_cloud_media WHERE id::text=$1 AND tenant_id=$2 AND number_id=$3`, c.Param("media"), n.Tenant, n.ID).Scan(&meta, &filename)
	if e != nil {
		commerceFail(c, e)
		return
	}
	data, mime, e := a.Cloud.Download(c.Request.Context(), n.Token, meta)
	if e != nil {
		fail(c, 502, e.Error())
		return
	}
	ok(c, gin.H{"data": base64.StdEncoding.EncodeToString(data), "mime": mime, "filename": filename})
}

var cloudLanguages = map[string]bool{"zh-CN": true, "zh-TW": true, "en": true, "es": true, "pt": true, "ar": true, "ru": true, "fr": true, "de": true, "ja": true, "ko": true, "vi": true, "th": true, "id": true, "hi": true}

func (a *App) cloudTranslate(c *gin.Context) {
	var b struct {
		Text   string `json:"text"`
		Target string `json:"target"`
	}
	if c.ShouldBindJSON(&b) != nil || strings.TrimSpace(b.Text) == "" || utf8.RuneCountInString(b.Text) > 4000 || !cloudLanguages[b.Target] {
		fail(c, 400, "每次可翻译 1–4000 字，请选择目标语言")
		return
	}
	q := url.Values{"client": {"gtx"}, "sl": {"auto"}, "tl": {b.Target}, "dt": {"t"}, "q": {b.Text}}
	req, _ := http.NewRequestWithContext(c.Request.Context(), "GET", "https://translate.googleapis.com/translate_a/single?"+q.Encode(), nil)
	res, e := a.TranslationHTTP.Do(req)
	if e != nil {
		fail(c, 502, "Google 翻译连接失败，请稍后重试")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		fail(c, 502, "Google 翻译暂不可用或已限流，请稍后重试")
		return
	}
	var v []json.RawMessage
	if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&v) != nil || len(v) == 0 {
		fail(c, 502, "翻译结果格式异常")
		return
	}
	var parts [][]json.RawMessage
	if json.Unmarshal(v[0], &parts) != nil {
		fail(c, 502, "翻译结果格式异常")
		return
	}
	var text strings.Builder
	for _, part := range parts {
		if len(part) > 0 {
			var t string
			_ = json.Unmarshal(part[0], &t)
			text.WriteString(t)
		}
	}
	if text.Len() == 0 || utf8.RuneCountInString(text.String()) > 32000 {
		fail(c, 502, "未获得译文，请稍后重试")
		return
	}
	// Store counts only. Translation content and credentials never enter usage logs.
	if _, e = a.DB.Exec(c.Request.Context(), `INSERT INTO usage_records(tenant_id,account_id,request_id,provider,input_chars,output_chars,target_language) VALUES($1,$2,gen_random_uuid(),'google-free',$3,$4,$5)`, identity(c).Tenant, c.Param("number"), utf8.RuneCountInString(b.Text), utf8.RuneCountInString(text.String()), b.Target); e != nil {
		slog.Error("cloud translation usage record failed")
	}
	ok(c, gin.H{"text": text.String(), "targetLanguage": b.Target, "provider": "google-free"})
}
