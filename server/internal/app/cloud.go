package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
	"gongdan007/server/internal/whatsappcloud"
)

func (a *App) cloudRoutes(public, admin, client *gin.RouterGroup) {
	public.GET("/whatsapp-cloud/webhooks/:app", a.cloudVerifyWebhook)
	public.POST("/whatsapp-cloud/webhooks/:app", a.cloudWebhook)
	admin.GET("/whatsapp-cloud/config", a.cloudConfig)
	admin.GET("/whatsapp-cloud/numbers", a.cloudNumbers)
	admin.POST("/whatsapp-cloud/numbers", a.rate, a.cloudCreateNumber)
	admin.PATCH("/whatsapp-cloud/numbers/:number", a.cloudUpdateNumber)
	admin.PUT("/whatsapp-cloud/numbers/:number/assignments", a.cloudAssign)
	admin.POST("/whatsapp-cloud/numbers/:number/verify", a.rate, a.cloudVerifyNumber)
	admin.POST("/whatsapp-cloud/numbers/:number/subscribe", a.rate, a.cloudSubscribe)
	admin.POST("/whatsapp-cloud/numbers/:number/webhook", a.cloudCallback)
	admin.POST("/whatsapp-cloud/numbers/:number/templates/sync", a.rate, a.cloudSyncTemplates)
	for _, group := range []*gin.RouterGroup{admin, client} {
		n := group.Group("/whatsapp-cloud/numbers/:number", a.cloudAuthorize)
		n.GET("/chats", a.cloudChats)
		n.POST("/chats", a.cloudCreateChat)
		n.GET("/chats/:chat/messages", a.cloudMessages)
		n.POST("/chats/:chat/messages", a.cloudSend)
		n.POST("/chats/:chat/read", a.cloudRead)
		n.GET("/templates", a.cloudTemplates)
		n.POST("/media", a.rate, a.cloudUpload)
		n.POST("/media/:media/download", a.cloudDownload)
		n.POST("/translate", a.rate, a.cloudTranslate)
	}
}

type cloudNumber struct {
	ID, Tenant, AppID, MetaAppID, PhoneID, WABA, Token, Secret string
	Enabled                                                    bool
}

func (a *App) cloudNumber(ctx context.Context, tenant, id string) (cloudNumber, error) {
	var n cloudNumber
	var token, secret string
	e := a.DB.QueryRow(ctx, `SELECT n.id::text,n.tenant_id::text,n.app_id::text,app.meta_app_id,n.phone_id,n.waba_id,n.token_cipher,app.secret_cipher,n.enabled FROM wa_cloud_numbers n JOIN wa_cloud_apps app ON app.id=n.app_id WHERE n.id::text=$1 AND n.tenant_id=$2`, id, tenant).Scan(&n.ID, &n.Tenant, &n.AppID, &n.MetaAppID, &n.PhoneID, &n.WABA, &token, &secret, &n.Enabled)
	if e != nil {
		return n, e
	}
	n.Token, e = security.Open(a.Key, token)
	if e == nil {
		n.Secret, e = security.Open(a.Key, secret)
	}
	return n, e
}
func (a *App) cloudAuthorize(c *gin.Context) {
	id := identity(c)
	var available bool
	e := a.DB.QueryRow(c.Request.Context(), `SELECT EXISTS(SELECT 1 FROM wa_cloud_numbers n WHERE n.id::text=$1 AND n.tenant_id=$2 AND ($3='' OR (n.enabled AND NOT EXISTS(SELECT 1 FROM client_account_preferences pref WHERE pref.account_id=n.id AND pref.device_id::text=$4 AND (pref.hidden OR pref.paused)) AND EXISTS(SELECT 1 FROM wa_cloud_assignments x JOIN login_codes l ON l.id=x.code_id WHERE x.number_id=n.id AND x.tenant_id=$2 AND x.code_id::text=$3 AND l.enabled AND l.deleted_at IS NULL AND l.expires_at>now() AND 'whatsapp_cloud'=ANY(l.allowed_platforms)))))`, c.Param("number"), id.Tenant, id.Code, id.Device).Scan(&available)
	if e != nil {
		dbError(c, e)
		return
	}
	if !available {
		fail(c, 404, "API 号码不可用或未分配给当前登录码")
		return
	}
	c.Next()
}
func (a *App) cloudJSON(c *gin.Context, query string, args ...any) {
	var data json.RawMessage
	if e := a.DB.QueryRow(c.Request.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(items)),'[]'::jsonb) FROM (`+query+`) items`, args...).Scan(&data); e != nil {
		dbError(c, e)
		return
	}
	ok(c, data)
}
func (a *App) cloudPublicURL() string {
	u, e := url.Parse(a.PublicURL)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return ""
	}
	return a.PublicURL
}
func (a *App) cloudConfig(c *gin.Context) {
	ok(c, gin.H{"publicURL": a.cloudPublicURL(), "graphVersion": a.Cloud.Version})
}
func (a *App) cloudNumbers(c *gin.Context) {
	a.cloudJSON(c, `SELECT n.id::text,p.label,n.phone_id AS "phoneId",n.waba_id AS "wabaId",app.meta_app_id AS "appId",n.display_phone AS "displayPhone",n.verified_name AS "verifiedName",n.quality,n.enabled,n.auth_status AS "authStatus",n.last_error AS "lastError",n.checked_at AS "checkedAt",n.subscribed_at AS "subscribedAt",app.verified_at AS "webhookVerifiedAt",app.last_event_at AS "lastEventAt",n.templates_at AS "templatesAt",COALESCE((SELECT jsonb_agg(x.code_id::text) FROM wa_cloud_assignments x JOIN login_codes l ON l.id=x.code_id WHERE x.number_id=n.id AND l.deleted_at IS NULL),'[]'::jsonb) AS "codeIds",(SELECT count(*) FROM wa_cloud_chats c WHERE c.number_id=n.id) AS "chatCount" FROM wa_cloud_numbers n JOIN platform_accounts p ON p.id=n.id JOIN wa_cloud_apps app ON app.id=n.app_id WHERE n.tenant_id=$1 ORDER BY p.created_at DESC`, identity(c).Tenant)
}
func (a *App) cloudCreateNumber(c *gin.Context) {
	var b struct {
		Label     string `json:"label"`
		AppID     string `json:"appId"`
		AppSecret string `json:"appSecret"`
		PhoneID   string `json:"phoneId"`
		WABA      string `json:"wabaId"`
		Token     string `json:"token"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "请完整填写接入资料")
		return
	}
	b.Label = strings.TrimSpace(b.Label)
	b.Token = strings.TrimSpace(b.Token)
	if b.Label == "" || utf8.RuneCountInString(b.Label) > 100 || !whatsappcloud.NumericID.MatchString(b.AppID) || !whatsappcloud.NumericID.MatchString(b.PhoneID) || !whatsappcloud.NumericID.MatchString(b.WABA) || len(b.AppSecret) < 16 || len(b.AppSecret) > 256 || len(b.Token) < 20 || len(b.Token) > 4096 {
		fail(c, 400, "请检查名称、应用 ID、应用密钥、号码 ID、WABA ID 和令牌")
		return
	}
	n, e := a.Cloud.Validate(c.Request.Context(), b.AppID, b.AppSecret, b.Token, b.WABA, b.PhoneID)
	if e != nil {
		fail(c, 400, e.Error())
		return
	}
	token, e := security.Seal(a.Key, b.Token)
	if e != nil {
		dbError(c, e)
		return
	}
	secret, e := security.Seal(a.Key, b.AppSecret)
	if e != nil {
		dbError(c, e)
		return
	}
	verify := security.Token()
	verifyCipher, e := security.Seal(a.Key, verify)
	if e != nil {
		dbError(c, e)
		return
	}
	id := identity(c)
	ctx := c.Request.Context()
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		// Meta has an app-level callback: all numbers in this app share one endpoint.
		var appID string
		e := tx.QueryRow(ctx, `INSERT INTO wa_cloud_apps(tenant_id,meta_app_id,secret_cipher,verify_cipher,verify_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(meta_app_id) DO UPDATE SET secret_cipher=EXCLUDED.secret_cipher WHERE wa_cloud_apps.tenant_id=EXCLUDED.tenant_id RETURNING id::text`, id.Tenant, b.AppID, secret, verifyCipher, security.Hash(verify)).Scan(&appID)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, businessError("此 Meta 应用已接入其他团队")
		}
		if e != nil {
			return nil, e
		}
		var exists bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM wa_cloud_numbers WHERE phone_id=$1)`, b.PhoneID).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, businessError("此号码已接入，请在号码列表编辑")
		}
		var numberID string
		if e = tx.QueryRow(ctx, `INSERT INTO platform_accounts(tenant_id,platform,label,connection_type) VALUES($1,'whatsapp',$2,'cloud') RETURNING id::text`, id.Tenant, b.Label).Scan(&numberID); e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO wa_cloud_numbers(id,tenant_id,app_id,phone_id,waba_id,token_cipher,display_phone,verified_name,quality) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, numberID, id.Tenant, appID, b.PhoneID, b.WABA, token, n.DisplayPhone, n.Name, n.Quality)
		if e != nil {
			return nil, e
		}
		return gin.H{"id": numberID}, auditTx(ctx, tx, c, id.Tenant, "whatsapp-cloud.number.create:"+numberID)
	})
}
func (a *App) cloudUpdateNumber(c *gin.Context) {
	var b struct {
		Label     string `json:"label"`
		Enabled   bool   `json:"enabled"`
		Token     string `json:"token"`
		AppSecret string `json:"appSecret"`
	}
	if c.ShouldBindJSON(&b) != nil || strings.TrimSpace(b.Label) == "" || utf8.RuneCountInString(b.Label) > 100 || len(b.Token) > 4096 || len(b.AppSecret) > 256 {
		fail(c, 400, "请检查号码名称和授权资料")
		return
	}
	id := identity(c)
	n, e := a.cloudNumber(c.Request.Context(), id.Tenant, c.Param("number"))
	if e != nil {
		commerceFail(c, e)
		return
	}
	token, secret := n.Token, n.Secret
	if b.Token != "" {
		token = strings.TrimSpace(b.Token)
	}
	if b.AppSecret != "" {
		secret = strings.TrimSpace(b.AppSecret)
	}
	if token != n.Token || secret != n.Secret {
		if _, e = a.Cloud.Validate(c.Request.Context(), n.MetaAppID, secret, token, n.WABA, n.PhoneID); e != nil {
			fail(c, 400, e.Error())
			return
		}
	}
	cipher, e := security.Seal(a.Key, token)
	if e != nil {
		dbError(c, e)
		return
	}
	secretCipher, e := security.Seal(a.Key, secret)
	if e != nil {
		dbError(c, e)
		return
	}
	ctx := c.Request.Context()
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		if _, e := tx.Exec(ctx, `UPDATE platform_accounts SET label=$3 WHERE id=$1 AND tenant_id=$2`, n.ID, id.Tenant, strings.TrimSpace(b.Label)); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, `UPDATE wa_cloud_numbers SET enabled=$3,token_cipher=$4,auth_status=CASE WHEN $5 THEN 'valid' ELSE auth_status END,last_error=CASE WHEN $5 THEN '' ELSE last_error END WHERE id=$1 AND tenant_id=$2`, n.ID, id.Tenant, b.Enabled, cipher, token != n.Token || secret != n.Secret); e != nil {
			return nil, e
		}
		if b.AppSecret != "" {
			if _, e := tx.Exec(ctx, `UPDATE wa_cloud_apps SET secret_cipher=$3 WHERE id=$1 AND tenant_id=$2`, n.AppID, id.Tenant, secretCipher); e != nil {
				return nil, e
			}
		}
		return true, auditTx(ctx, tx, c, id.Tenant, "whatsapp-cloud.number.update:"+n.ID)
	})
}
func (a *App) cloudAssign(c *gin.Context) {
	var b struct {
		CodeIDs []string `json:"codeIds"`
	}
	if c.ShouldBindJSON(&b) != nil || len(b.CodeIDs) > 500 {
		fail(c, 400, "请选择登录码")
		return
	}
	for _, id := range b.CodeIDs {
		if requestKey(id) != nil {
			fail(c, 400, "登录码编号无效")
			return
		}
	}
	id := identity(c)
	ctx := c.Request.Context()
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		var number string
		if e := tx.QueryRow(ctx, `SELECT id::text FROM wa_cloud_numbers WHERE id::text=$1 AND tenant_id=$2 FOR UPDATE`, c.Param("number"), id.Tenant).Scan(&number); e != nil {
			return nil, e
		}
		for _, code := range b.CodeIDs {
			var valid bool
			if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM login_codes WHERE id=$1 AND tenant_id=$2 AND enabled AND deleted_at IS NULL AND expires_at>now() AND 'whatsapp_cloud'=ANY(allowed_platforms))`, code, id.Tenant).Scan(&valid); e != nil {
				return nil, e
			}
			if !valid {
				return nil, commerceError{400, "所选登录码不可用，或尚未勾选 WhatsApp API 平台"}
			}
		}
		if _, e := tx.Exec(ctx, `DELETE FROM wa_cloud_assignments WHERE number_id=$1 AND tenant_id=$2`, number, id.Tenant); e != nil {
			return nil, e
		}
		for _, code := range b.CodeIDs {
			if _, e := tx.Exec(ctx, `INSERT INTO wa_cloud_assignments VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, id.Tenant, number, code); e != nil {
				return nil, e
			}
		}
		return true, auditTx(ctx, tx, c, id.Tenant, "whatsapp-cloud.assign:"+number)
	})
}
func (a *App) cloudCallback(c *gin.Context) {
	n, e := a.cloudNumber(c.Request.Context(), identity(c).Tenant, c.Param("number"))
	if e != nil {
		commerceFail(c, e)
		return
	}
	var cipher string
	if e = a.DB.QueryRow(c.Request.Context(), `SELECT verify_cipher FROM wa_cloud_apps WHERE id=$1 AND tenant_id=$2`, n.AppID, n.Tenant).Scan(&cipher); e != nil {
		dbError(c, e)
		return
	}
	verify, e := security.Open(a.Key, cipher)
	if e != nil {
		dbError(c, e)
		return
	}
	path := "/api/v1/whatsapp-cloud/webhooks/" + n.AppID
	callback := ""
	if a.cloudPublicURL() != "" {
		callback = a.cloudPublicURL() + path
	}
	a.audit(c, n.Tenant, identity(c).Actor, "whatsapp-cloud.callback.view", true)
	ok(c, gin.H{"url": callback, "path": path, "verifyToken": verify})
}
func (a *App) cloudVerifyNumber(c *gin.Context) {
	n, e := a.cloudNumber(c.Request.Context(), identity(c).Tenant, c.Param("number"))
	if e != nil {
		commerceFail(c, e)
		return
	}
	info, e := a.Cloud.Validate(c.Request.Context(), n.MetaAppID, n.Secret, n.Token, n.WABA, n.PhoneID)
	if e != nil {
		a.DB.Exec(c.Request.Context(), `UPDATE wa_cloud_numbers SET auth_status='check_failed',last_error=$2,checked_at=now() WHERE id=$1`, n.ID, e.Error())
		fail(c, 400, e.Error())
		return
	}
	_, e = a.DB.Exec(c.Request.Context(), `UPDATE wa_cloud_numbers SET auth_status='valid',last_error='',checked_at=now(),display_phone=$2,verified_name=$3,quality=$4 WHERE id=$1`, n.ID, info.DisplayPhone, info.Name, info.Quality)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, true)
}
func (a *App) cloudSubscribe(c *gin.Context) {
	n, e := a.cloudNumber(c.Request.Context(), identity(c).Tenant, c.Param("number"))
	if e != nil {
		commerceFail(c, e)
		return
	}
	if e = a.Cloud.Subscribe(c.Request.Context(), n.Token, n.WABA); e != nil {
		fail(c, 400, e.Error())
		return
	}
	if _, e = a.DB.Exec(c.Request.Context(), `UPDATE wa_cloud_numbers SET subscribed_at=now() WHERE tenant_id=$1 AND app_id=$2 AND waba_id=$3`, n.Tenant, n.AppID, n.WABA); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, n.Tenant, identity(c).Actor, "whatsapp-cloud.subscribe", true)
	ok(c, true)
}
func (a *App) cloudSyncTemplates(c *gin.Context) {
	n, e := a.cloudNumber(c.Request.Context(), identity(c).Tenant, c.Param("number"))
	if e != nil {
		commerceFail(c, e)
		return
	}
	templates, e := a.Cloud.Templates(c.Request.Context(), n.Token, n.WABA)
	if e != nil {
		fail(c, 400, e.Error())
		return
	}
	b, _ := json.Marshal(templates)
	if _, e = a.DB.Exec(c.Request.Context(), `UPDATE wa_cloud_numbers SET templates=$3,templates_at=now() WHERE tenant_id=$1 AND waba_id=$2`, n.Tenant, n.WABA, b); e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"count": len(templates)})
}
