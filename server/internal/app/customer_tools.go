package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
)

func (a *App) customerToolsRoutes(client *gin.RouterGroup) {
	t := client.Group("/tools")
	t.GET("/assets", a.toolAssets)
	t.POST("/assets", a.saveToolAsset)
	t.PATCH("/assets/:asset", a.saveToolAsset)
	t.DELETE("/assets/:asset", a.deleteToolAsset)
	t.GET("/assets/:asset", a.getToolAsset)
	t.GET("/tags", a.toolTags)
	t.POST("/tags", a.createToolTag)
	t.POST("/customer", a.toolCustomer)
	t.PUT("/customer", a.saveToolCustomer)
	t.PUT("/customer/tag", a.assignToolTag)
}

// Resolve the platform from an authorized account, including assigned Cloud numbers.
func (a *App) toolCustomerIdentity(c *gin.Context, account, identifier string) (string, string, bool) {
	id := identity(c)
	var platform string
	err := a.DB.QueryRow(c.Request.Context(), `SELECT a.platform FROM platform_accounts a WHERE a.id::text=$1 AND a.tenant_id=$2 AND (
 (a.connection_type='web' AND a.code_id::text=$3 AND a.device_id::text=$4 AND (a.proxy_id IS NULL OR EXISTS(SELECT 1 FROM proxies p WHERE p.id=a.proxy_id AND p.enabled)) AND EXISTS(SELECT 1 FROM login_codes l WHERE l.id=a.code_id AND a.platform=ANY(l.allowed_platforms))) OR
 (a.connection_type='cloud' AND EXISTS(SELECT 1 FROM wa_cloud_numbers n JOIN wa_cloud_assignments x ON x.number_id=n.id JOIN login_codes l ON l.id=x.code_id WHERE n.id=a.id AND n.enabled AND x.tenant_id=$2 AND x.code_id::text=$3 AND 'whatsapp_cloud'=ANY(l.allowed_platforms)))
 )`, account, id.Tenant, id.Code, id.Device).Scan(&platform)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 404, "账号不可用或未授权")
		return "", "", false
	}
	if err != nil {
		dbError(c, err)
		return "", "", false
	}
	normalized, _, err := normalizeCustomer(platform, identifier, "")
	if err != nil || normalized == "" {
		fail(c, 400, "请先选择可识别的客户聊天")
		return "", "", false
	}
	return platform, normalized, true
}

type toolCustomerInput struct {
	AccountID  string            `json:"accountId"`
	Identifier string            `json:"identifier"`
	Details    map[string]string `json:"details"`
	Language   string            `json:"language"`
	Version    int               `json:"version"`
	TagID      string            `json:"tagId"`
	Assigned   bool              `json:"assigned"`
}

func (a *App) toolCustomer(c *gin.Context) {
	var b toolCustomerInput
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "客户参数无效")
		return
	}
	platform, identifier, valid := a.toolCustomerIdentity(c, b.AccountID, b.Identifier)
	if !valid {
		return
	}
	var details json.RawMessage
	var language string
	var version int
	err := a.DB.QueryRow(c.Request.Context(), `SELECT details,language,version FROM customer_profiles WHERE tenant_id=$1 AND platform=$2 AND identifier=$3`, identity(c).Tenant, platform, identifier).Scan(&details, &language, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		details = json.RawMessage(`{}`)
		language = "en"
		version = 0
	} else if err != nil {
		dbError(c, err)
		return
	}
	var tags []string
	err = a.DB.QueryRow(c.Request.Context(), `SELECT COALESCE(array_agg(tag_id::text),'{}') FROM customer_tag_links WHERE tenant_id=$1 AND platform=$2 AND identifier=$3`, identity(c).Tenant, platform, identifier).Scan(&tags)
	if err != nil {
		dbError(c, err)
		return
	}
	ok(c, gin.H{"identifier": identifier, "platform": platform, "details": details, "language": language, "version": version, "tags": tags})
}
func (a *App) saveToolCustomer(c *gin.Context) {
	var b toolCustomerInput
	if c.ShouldBindJSON(&b) != nil || b.Version < 0 || b.Details == nil || !cloudLanguages[b.Language] {
		fail(c, 400, "客户资料或翻译语言无效")
		return
	}
	limits := map[string]int{"name": 150, "phone": 60, "country": 80, "address": 500, "gender": 10, "source": 100, "dealStatus": 50, "level": 50, "notes": 6000}
	for key, value := range b.Details {
		max, ok := limits[key]
		if !ok || utf8.RuneCountInString(value) > max {
			fail(c, 400, "客户资料字段无效或过长")
			return
		}
	}
	platform, identifier, valid := a.toolCustomerIdentity(c, b.AccountID, b.Identifier)
	if !valid {
		return
	}
	details, _ := json.Marshal(b.Details)
	var version int
	err := a.DB.QueryRow(c.Request.Context(), `INSERT INTO customer_profiles(tenant_id,platform,identifier,details,language) SELECT $1,$2,$3,$4,$5 WHERE $6=0 OR EXISTS(SELECT 1 FROM customer_profiles WHERE tenant_id=$1 AND platform=$2 AND identifier=$3) ON CONFLICT(tenant_id,platform,identifier) DO UPDATE SET details=EXCLUDED.details,language=EXCLUDED.language,version=customer_profiles.version+1,updated_at=now() WHERE customer_profiles.version=$6 RETURNING version`, identity(c).Tenant, platform, identifier, details, b.Language, b.Version).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 409, "该客户资料已被更新，请刷新后再保存")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	ok(c, gin.H{"version": version})
}
func (a *App) toolTags(c *gin.Context) {
	a.cloudJSON(c, `SELECT id::text,name FROM customer_tags WHERE tenant_id=$1 ORDER BY name,id`, identity(c).Tenant)
}
func (a *App) createToolTag(c *gin.Context) {
	var b struct {
		Name string `json:"name"`
	}
	if c.ShouldBindJSON(&b) != nil || strings.TrimSpace(b.Name) == "" || utf8.RuneCountInString(b.Name) > 30 {
		fail(c, 400, "标签名称为 1–30 字")
		return
	}
	var tag string
	err := a.DB.QueryRow(c.Request.Context(), `INSERT INTO customer_tags(tenant_id,name) VALUES($1,$2) ON CONFLICT(tenant_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id::text`, identity(c).Tenant, strings.TrimSpace(b.Name)).Scan(&tag)
	if err != nil {
		dbError(c, err)
		return
	}
	ok(c, gin.H{"id": tag, "name": strings.TrimSpace(b.Name)})
}
func (a *App) assignToolTag(c *gin.Context) {
	var b toolCustomerInput
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "标签参数无效")
		return
	}
	platform, identifier, valid := a.toolCustomerIdentity(c, b.AccountID, b.Identifier)
	if !valid {
		return
	}
	var result string
	var err error
	if b.Assigned {
		err = a.DB.QueryRow(c.Request.Context(), `INSERT INTO customer_tag_links(tenant_id,platform,identifier,tag_id) SELECT tenant_id,$2,$3,id FROM customer_tags WHERE tenant_id=$1 AND id::text=$4 ON CONFLICT(tenant_id,platform,identifier,tag_id) DO UPDATE SET tag_id=EXCLUDED.tag_id RETURNING tag_id::text`, identity(c).Tenant, platform, identifier, b.TagID).Scan(&result)
	} else {
		err = a.DB.QueryRow(c.Request.Context(), `DELETE FROM customer_tag_links WHERE tenant_id=$1 AND platform=$2 AND identifier=$3 AND tag_id::text=$4 RETURNING tag_id::text`, identity(c).Tenant, platform, identifier, b.TagID).Scan(&result)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 404, "标签不存在或已移除")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	ok(c, true)
}
func (a *App) toolAssets(c *gin.Context) {
	a.cloudJSON(c, `SELECT id::text,kind,title,category,body,mime,filename,version,CASE WHEN owner_code_id IS NULL THEN 'team' ELSE 'personal' END AS scope FROM quick_assets WHERE tenant_id=$1 AND (owner_code_id IS NULL OR owner_code_id::text=$2) ORDER BY updated_at DESC,id`, identity(c).Tenant, identity(c).Code)
}
func (a *App) getToolAsset(c *gin.Context) {
	var data, mime, filename, body, kind string
	err := a.DB.QueryRow(c.Request.Context(), `SELECT data_cipher,mime,filename,body,kind FROM quick_assets WHERE tenant_id=$1 AND id::text=$2 AND (owner_code_id IS NULL OR owner_code_id::text=$3)`, identity(c).Tenant, c.Param("asset"), identity(c).Code).Scan(&data, &mime, &filename, &body, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 404, "素材不存在")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	if data != "" {
		data, err = security.Open(a.Key, data)
		if err != nil {
			dbError(c, err)
			return
		}
	}
	ok(c, gin.H{"kind": kind, "data": data, "mime": mime, "filename": filename, "body": body})
}
func (a *App) saveToolAsset(c *gin.Context) {
	var b struct {
		Kind     string `json:"kind"`
		Title    string `json:"title"`
		Category string `json:"category"`
		Body     string `json:"body"`
		Scope    string `json:"scope"`
		Data     string `json:"data"`
		Mime     string `json:"mime"`
		Filename string `json:"filename"`
		Version  int    `json:"version"`
	}
	if c.ShouldBindJSON(&b) != nil || (b.Kind != "text" && b.Kind != "image") || (b.Scope != "personal" && b.Scope != "team") || strings.TrimSpace(b.Title) == "" || utf8.RuneCountInString(b.Title) > 80 || utf8.RuneCountInString(b.Category) > 40 || utf8.RuneCountInString(b.Body) > 4000 || len(b.Filename) > 200 {
		fail(c, 400, "素材参数无效，标题最多 80 字、话术最多 4000 字")
		return
	}
	b.Title = strings.TrimSpace(b.Title)
	b.Category = strings.TrimSpace(b.Category)
	if b.Category == "" {
		b.Category = "默认"
	}
	if b.Kind == "text" && (strings.TrimSpace(b.Body) == "" || b.Data != "") {
		fail(c, 400, "请填写话术内容")
		return
	}
	cipher := ""
	if b.Kind == "image" {
		data, err := base64.StdEncoding.DecodeString(b.Data)
		if err != nil || len(data) == 0 || len(data) > 5<<20 || (b.Mime != "image/png" && b.Mime != "image/jpeg") || http.DetectContentType(data) != b.Mime {
			fail(c, 400, "请选择 5 MB 以内的 PNG 或 JPG 图片")
			return
		}
		config, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 25000000 {
			fail(c, 400, "图片尺寸无效或超过 2500 万像素")
			return
		}
		cipher, err = security.Seal(a.Key, b.Data)
		if err != nil {
			dbError(c, err)
			return
		}
	}
	var owner any
	if b.Scope == "personal" {
		owner = identity(c).Code
	}
	var asset string
	var version int
	var err error
	if c.Param("asset") == "" {
		err = a.DB.QueryRow(c.Request.Context(), `INSERT INTO quick_assets(tenant_id,owner_code_id,kind,title,category,body,mime,filename,data_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text,version`, identity(c).Tenant, owner, b.Kind, b.Title, b.Category, b.Body, b.Mime, b.Filename, cipher).Scan(&asset, &version)
	} else {
		err = a.DB.QueryRow(c.Request.Context(), `UPDATE quick_assets SET title=$4,category=$5,body=$6,mime=$7,filename=$8,data_cipher=$9,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id::text=$2 AND (owner_code_id IS NULL OR owner_code_id::text=$3) AND version=$10 AND kind=$11 AND owner_code_id IS NOT DISTINCT FROM $12::uuid RETURNING id::text,version`, identity(c).Tenant, c.Param("asset"), identity(c).Code, b.Title, b.Category, b.Body, b.Mime, b.Filename, cipher, b.Version, b.Kind, owner).Scan(&asset, &version)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 409, "素材已更新或不可编辑，请刷新后重试")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	ok(c, gin.H{"id": asset, "version": version})
}
func (a *App) deleteToolAsset(c *gin.Context) {
	r, err := a.DB.Exec(c.Request.Context(), `DELETE FROM quick_assets WHERE tenant_id=$1 AND id::text=$2 AND (owner_code_id IS NULL OR owner_code_id::text=$3)`, identity(c).Tenant, c.Param("asset"), identity(c).Code)
	if err != nil {
		dbError(c, err)
		return
	}
	if r.RowsAffected() == 0 {
		fail(c, 404, "素材不存在")
		return
	}
	ok(c, true)
}
