package app

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
	"gongdan007/server/internal/whatsappcloud"
)

func (a *App) cloudChats(c *gin.Context) {
	a.cloudJSON(c, `SELECT ch.id::text,ch.customer_id AS "customerId",ch.name,COALESCE(cp.language,'en') AS language,ch.last_inbound_at AS "lastInboundAt",ch.last_message_at AS "lastMessageAt",ch.unread,COALESCE(v.duplicate_account OR v.duplicate_ip,false) AS duplicate,COALESCE((SELECT body FROM wa_cloud_messages m WHERE m.chat_id=ch.id ORDER BY m.seq DESC LIMIT 1),'') AS preview FROM wa_cloud_chats ch LEFT JOIN customer_profiles cp ON cp.tenant_id=ch.tenant_id AND cp.platform='whatsapp' AND cp.identifier=ch.customer_id LEFT JOIN customer_conversations v ON v.account_id=ch.number_id AND v.tenant_id=ch.tenant_id AND v.identifier=ch.customer_id WHERE ch.tenant_id=$1 AND ch.number_id::text=$2 AND ($3='' OR ch.name ILIKE '%'||$3||'%' OR ch.customer_id ILIKE '%'||$3||'%') ORDER BY ch.last_message_at DESC,ch.id DESC LIMIT 100 OFFSET $4`, identity(c).Tenant, c.Param("number"), truncate(c.Query("search"), 100), cloudOffset(c))
}
func cloudOffset(c *gin.Context) int {
	n, _ := strconv.Atoi(c.Query("offset"))
	if n < 0 || n > 100000 {
		n = 0
	}
	return n
}
func (a *App) cloudCreateChat(c *gin.Context) {
	var b struct {
		CustomerID string `json:"customerId"`
		Name       string `json:"name"`
	}
	if c.ShouldBindJSON(&b) != nil || utf8.RuneCountInString(b.Name) > 150 {
		fail(c, 400, "请填写客户手机号")
		return
	}
	customer, _, e := normalizeCustomer("whatsapp", b.CustomerID, "")
	if e != nil || !phoneNumber.MatchString(customer) {
		fail(c, 400, "请填写包含国家区号的客户手机号")
		return
	}
	var chat string
	e = a.DB.QueryRow(c.Request.Context(), `INSERT INTO wa_cloud_chats(tenant_id,number_id,customer_id,name) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,number_id,customer_id) DO UPDATE SET name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE wa_cloud_chats.name END RETURNING id::text`, identity(c).Tenant, c.Param("number"), customer, strings.TrimSpace(b.Name)).Scan(&chat)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"id": chat})
}
func (a *App) cloudMessages(c *gin.Context) {
	before, _ := strconv.ParseInt(c.Query("before"), 10, 64)
	if before < 0 {
		before = 0
	}
	a.cloudJSON(c, `SELECT id::text,seq,direction,kind,body,COALESCE(payload->>'originalText','') AS "originalText",COALESCE(payload->>'translationLanguage','') AS "translationLanguage",status,error,occurred_at AS "occurredAt",created_at AS "createdAt",CASE WHEN direction='in' THEN COALESCE(payload->>'mediaId','') ELSE COALESCE(payload->>'localMediaId','') END AS "mediaId",COALESCE(payload->>'filename','') AS filename FROM wa_cloud_messages WHERE tenant_id=$1 AND number_id::text=$2 AND chat_id::text=$3 AND ($4=0 OR seq<$4) ORDER BY seq DESC LIMIT 100`, identity(c).Tenant, c.Param("number"), c.Param("chat"), before)
}
func (a *App) cloudRead(c *gin.Context) {
	var b struct {
		ThroughSeq int64 `json:"throughSeq"`
	}
	if c.ShouldBindJSON(&b) != nil || b.ThroughSeq < 1 {
		fail(c, 400, "已读位置无效")
		return
	}
	_, e := a.DB.Exec(c.Request.Context(), `UPDATE wa_cloud_chats ch SET unread=(SELECT count(*) FROM wa_cloud_messages m WHERE m.chat_id=ch.id AND m.direction='in' AND m.seq>$4) WHERE ch.id::text=$1 AND ch.tenant_id=$2 AND ch.number_id::text=$3`, c.Param("chat"), identity(c).Tenant, c.Param("number"), b.ThroughSeq)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, true)
}

var templateVariable = regexp.MustCompile(`\{\{([0-9]+)\}\}`)

// The first release supports positional body parameters and static text headers.
// Dynamic buttons, named parameters and media headers are deliberately not sent partially.
func templateInfo(t whatsappcloud.Template) (string, int, bool) {
	body := ""
	count := 0
	allowed := t.Status == "APPROVED" && t.ParameterFormat != "NAMED"
	for _, part := range t.Components {
		switch part.Type {
		case "BODY":
			body = part.Text
			seen := map[int]bool{}
			for _, m := range templateVariable.FindAllStringSubmatch(part.Text, -1) {
				n, _ := strconv.Atoi(m[1])
				if n < 1 || n > 30 {
					allowed = false
				}
				seen[n] = true
				if n > count {
					count = n
				}
			}
			if len(seen) != count {
				allowed = false
			}
		case "HEADER":
			if part.Format != "TEXT" || strings.Contains(part.Text, "{{") {
				allowed = false
			}
		case "FOOTER":
		default:
			allowed = false
		}
	}
	return body, count, allowed
}
func (a *App) cloudTemplates(c *gin.Context) {
	var templates []whatsappcloud.Template
	if e := a.DB.QueryRow(c.Request.Context(), `SELECT templates FROM wa_cloud_numbers WHERE id::text=$1 AND tenant_id=$2`, c.Param("number"), identity(c).Tenant).Scan(&templates); e != nil {
		dbError(c, e)
		return
	}
	out := []gin.H{}
	for _, t := range templates {
		body, count, supported := templateInfo(t)
		out = append(out, gin.H{"name": t.Name, "language": t.Language, "status": t.Status, "body": body, "parameterCount": count, "supported": supported})
	}
	ok(c, out)
}

type cloudSendInput struct {
	OriginalText        string   `json:"originalText,omitempty"`
	TranslationLanguage string   `json:"translationLanguage,omitempty"`
	RequestID           string   `json:"requestId"`
	Kind                string   `json:"kind"`
	Text                string   `json:"text"`
	TemplateName        string   `json:"templateName"`
	Language            string   `json:"language"`
	Parameters          []string `json:"parameters"`
	MediaID             string   `json:"mediaId"`
}

func (a *App) cloudSend(c *gin.Context) {
	var b cloudSendInput
	if c.ShouldBindJSON(&b) != nil || requestKey(b.RequestID) != nil || utf8.RuneCountInString(b.Text) > 4096 || len(b.Parameters) > 30 {
		fail(c, 400, "消息内容或请求编号无效")
		return
	}
	if utf8.RuneCountInString(b.OriginalText) > 4000 || (b.OriginalText != "" && (!cloudLanguages[b.TranslationLanguage] || b.Kind == "template" || b.Kind == "audio")) || (b.TranslationLanguage != "" && !cloudLanguages[b.TranslationLanguage]) {
		fail(c, 400, "翻译原文或目标语言无效")
		return
	}
	b.Text = strings.TrimSpace(b.Text)
	raw, _ := json.Marshal(b)
	fingerprint := security.Hash(string(raw))
	id := identity(c)
	ctx := c.Request.Context()
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		// Number lock serializes request-id reuse and concurrent operator sends.
		var enabled bool
		var templates []whatsappcloud.Template
		if e := tx.QueryRow(ctx, `SELECT enabled,templates FROM wa_cloud_numbers WHERE id::text=$1 AND tenant_id=$2 FOR UPDATE`, c.Param("number"), id.Tenant).Scan(&enabled, &templates); e != nil {
			return nil, e
		}
		if !enabled {
			return nil, businessError("API 号码已停用")
		}
		var existing, old, oldChat, status string
		e := tx.QueryRow(ctx, `SELECT id::text,fingerprint,chat_id::text,status FROM wa_cloud_messages WHERE tenant_id=$1 AND number_id::text=$2 AND request_id=$3`, id.Tenant, c.Param("number"), b.RequestID).Scan(&existing, &old, &oldChat, &status)
		if e == nil {
			if old != fingerprint || oldChat != c.Param("chat") {
				return nil, businessError("请求编号已使用，请核对消息后重试")
			}
			return gin.H{"id": existing, "status": status}, nil
		}
		if e != pgx.ErrNoRows {
			return nil, e
		}
		var customer string
		var inbound *time.Time
		if e = tx.QueryRow(ctx, `SELECT customer_id,last_inbound_at FROM wa_cloud_chats WHERE id::text=$1 AND number_id::text=$2 AND tenant_id=$3`, c.Param("chat"), c.Param("number"), id.Tenant).Scan(&customer, &inbound); e != nil {
			return nil, e
		}
		payload := gin.H{"messaging_product": "whatsapp", "recipient_type": "individual", "to": customer, "type": b.Kind, "biz_opaque_callback_data": b.RequestID}
		body := b.Text
		if b.Kind != "template" && (inbound == nil || time.Since(*inbound) >= 24*time.Hour) {
			return nil, businessError("客户尚未发来消息或已超出 24 小时客服窗口，请发送获批模板")
		}
		switch b.Kind {
		case "text":
			if body == "" {
				return nil, commerceError{400, "请填写消息内容"}
			}
			payload["text"] = gin.H{"body": body, "preview_url": false}
		case "template":
			var selected *whatsappcloud.Template
			for i := range templates {
				if templates[i].Name == b.TemplateName && templates[i].Language == b.Language {
					selected = &templates[i]
					break
				}
			}
			if selected == nil {
				return nil, businessError("模板未同步，请管理员同步获批模板")
			}
			preview, count, supported := templateInfo(*selected)
			if !supported || count != len(b.Parameters) {
				return nil, commerceError{400, "模板未获批、参数不完整或当前不支持此模板格式"}
			}
			params := []gin.H{}
			for i, p := range b.Parameters {
				if strings.TrimSpace(p) == "" || utf8.RuneCountInString(p) > 1024 {
					return nil, commerceError{400, "请填写模板参数，每项最多 1024 字"}
				}
				params = append(params, gin.H{"type": "text", "text": p})
				preview = strings.ReplaceAll(preview, "{{"+strconv.Itoa(i+1)+"}}", p)
			}
			template := gin.H{"name": selected.Name, "language": gin.H{"code": selected.Language}}
			if len(params) > 0 {
				template["components"] = []gin.H{{"type": "body", "parameters": params}}
			}
			payload["template"] = template
			body = preview
		case "image", "audio", "video", "document":
			if b.Kind == "audio" && body != "" {
				return nil, commerceError{400, "音频不支持附带文字，请清空回复内容后发送"}
			}
			var meta, mime, filename string
			e = tx.QueryRow(ctx, `SELECT meta_id,mime,filename FROM wa_cloud_media WHERE id::text=$1 AND tenant_id=$2 AND number_id::text=$3`, b.MediaID, id.Tenant, c.Param("number")).Scan(&meta, &mime, &filename)
			if e != nil {
				return nil, e
			}
			if mediaKind(mime) != b.Kind {
				return nil, commerceError{400, "文件类型不匹配"}
			}
			if utf8.RuneCountInString(body) > 1024 {
				return nil, commerceError{400, "附件说明最多 1024 字"}
			}
			media := gin.H{"id": meta}
			if b.Kind != "audio" && body != "" {
				media["caption"] = body
			}
			if b.Kind == "document" {
				media["filename"] = filename
			}
			payload[b.Kind] = media
			payload["localMediaId"] = b.MediaID
			payload["filename"] = filename
			if body == "" {
				body = "[" + filename + "]"
			}
		default:
			return nil, commerceError{400, "暂不支持此消息类型"}
		}
		if b.OriginalText != "" {
			payload["originalText"] = b.OriginalText
			payload["translationLanguage"] = b.TranslationLanguage
		}
		data, _ := json.Marshal(payload)
		var message string
		e = tx.QueryRow(ctx, `INSERT INTO wa_cloud_messages(tenant_id,number_id,chat_id,direction,kind,body,payload,request_id,fingerprint,source_code_id,actor,status) VALUES($1,$2,$3,'out',$4,$5,$6,$7,$8,NULLIF($9,'')::uuid,$10,'queued') RETURNING id::text`, id.Tenant, c.Param("number"), c.Param("chat"), b.Kind, body, data, b.RequestID, fingerprint, id.Code, id.Actor).Scan(&message)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE wa_cloud_chats SET last_message_at=now() WHERE id::text=$1 AND tenant_id=$2`, c.Param("chat"), id.Tenant); e != nil {
			return nil, e
		}
		return gin.H{"id": message, "status": "queued"}, nil
	})
}
