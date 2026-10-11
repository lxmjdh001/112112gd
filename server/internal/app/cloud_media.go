package app

import (
	"encoding/base64"
	"gongdan007/server/internal/translation"
	"log/slog"
	"net/http"
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

var cloudLanguages = translation.Languages

func (a *App) cloudTranslate(c *gin.Context) {
	var b struct {
		Text   string `json:"text"`
		Target string `json:"target"`
		Source string `json:"source"`
	}
	if c.ShouldBindJSON(&b) != nil || strings.TrimSpace(b.Text) == "" || utf8.RuneCountInString(b.Text) > 4000 || !cloudLanguages[b.Target] || (b.Source != "" && !cloudLanguages[b.Source]) {
		fail(c, 400, "每次可翻译 1–4000 字，请选择目标语言")
		return
	}
	result, e := a.Translations.Translate(c.Request.Context(), a.TranslationHTTP, identity(c).Tenant+":"+c.Param("number"), b.Text, b.Target, b.Source)
	if e != nil {
		fail(c, 502, e.Error())
		return
	}
	// Store counts only; cache hits and same-language passthrough consume no quota.
	if !result.Cached && result.Provider != "original" {
		if _, e = a.DB.Exec(c.Request.Context(), `INSERT INTO usage_records(tenant_id,account_id,request_id,provider,input_chars,output_chars,target_language) VALUES($1,$2,gen_random_uuid(),$3,$4,$5,$6)`, identity(c).Tenant, c.Param("number"), result.Provider, utf8.RuneCountInString(strings.TrimSpace(b.Text)), utf8.RuneCountInString(result.Text), b.Target); e != nil {
			slog.Error("cloud translation usage record failed")
		}
	}
	ok(c, result)
}
