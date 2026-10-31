package app

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func (a *App) teamSupervisionRoutes(admin, client *gin.RouterGroup) {
	admin.GET("/team/settings", a.teamSettings)
	admin.PUT("/team/settings", a.saveTeamSettings)
	admin.GET("/team/options", a.teamOptions)
	admin.GET("/team/leads", a.teamLeads)
	admin.GET("/team/customers", a.teamCustomers)
	admin.GET("/team/overview", a.teamOverview)
	admin.GET("/team/messages", a.teamMessages)
	client.GET("/team-settings", a.teamSettings)
	client.POST("/accounts/:id/chat-archive", a.ingestChatArchive)
}
func (a *App) teamSettings(c *gin.Context) {
	var enabled bool
	var updated *time.Time
	err := a.DB.QueryRow(c.Request.Context(), `SELECT enabled,updated_at FROM team_supervision_settings WHERE tenant_id=$1`, identity(c).Tenant).Scan(&enabled, &updated)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		dbError(c, err)
		return
	}
	ok(c, gin.H{"enabled": enabled, "updatedAt": updated, "historyScope": "loaded_only"})
}
func (a *App) saveTeamSettings(c *gin.Context) {
	var b struct {
		Enabled *bool `json:"enabled"`
	}
	if c.ShouldBindJSON(&b) != nil || b.Enabled == nil {
		fail(c, 400, "请选择同步状态")
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		_, err := tx.Exec(c.Request.Context(), `INSERT INTO team_supervision_settings(tenant_id,enabled) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`, identity(c).Tenant, *b.Enabled)
		if err != nil {
			return nil, err
		}
		return gin.H{"enabled": *b.Enabled}, auditTx(c.Request.Context(), tx, c, identity(c).Tenant, "team.sync.settings")
	})
}
func (a *App) teamOptions(c *gin.Context) {
	rows, err := a.DB.Query(c.Request.Context(), `SELECT id::text,label FROM login_codes WHERE tenant_id=$1 ORDER BY label,id`, identity(c).Tenant)
	if err != nil {
		dbError(c, err)
		return
	}
	codes, err := pgx.CollectRows(rows, pgx.RowToMap)
	if err != nil {
		dbError(c, err)
		return
	}
	if codes == nil {
		codes = []map[string]any{}
	}
	ok(c, gin.H{"codes": codes, "platforms": []gin.H{{"id": "whatsapp", "name": "WhatsApp"}, {"id": "line", "name": "LINE"}, {"id": "telegram", "name": "Telegram"}}})
}
func teamDate(value string, end bool) (*time.Time, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) == 10 {
		v, err := time.ParseInLocation("2006-01-02", value, beijing)
		if err != nil {
			return nil, err
		}
		if end {
			v = v.AddDate(0, 0, 1)
		}
		return &v, nil
	}
	v, err := time.Parse(time.RFC3339, value)
	return &v, err
}
func teamFilter(c *gin.Context, leads bool) (string, []any, bool) {
	search := strings.TrimSpace(c.Query("search"))
	platform := c.Query("platform")
	code := c.Query("codeId")
	if utf8.RuneCountInString(search) > 100 || (platform != "" && platform != "whatsapp" && platform != "line" && platform != "telegram") {
		fail(c, 400, "筛选条件无效")
		return "", nil, false
	}
	start, e := teamDate(c.Query("startAt"), false)
	if e != nil {
		fail(c, 400, "开始时间无效")
		return "", nil, false
	}
	end, e := teamDate(c.Query("endAt"), true)
	if e != nil || (start != nil && end != nil && !end.After(*start)) {
		fail(c, 400, "结束时间无效")
		return "", nil, false
	}
	from := ` FROM team_customer_rollup r WHERE r.tenant_id=$1 AND ($2='' OR r.platform=$2) AND ($3='' OR r.customer_id ILIKE '%'||$3||'%' OR r.name ILIKE '%'||$3||'%' OR r.account_label ILIKE '%'||$3||'%' OR r.code_label ILIKE '%'||$3||'%') AND ($4='' OR r.code_id=$4 OR EXISTS(SELECT 1 FROM wa_cloud_assignments x WHERE x.tenant_id=r.tenant_id AND x.number_id=r.account_id AND x.code_id::text=$4))`
	if leads {
		from += ` AND r.first_inbound IS NOT NULL AND ($5::timestamptz IS NULL OR r.first_inbound>=$5) AND ($6::timestamptz IS NULL OR r.first_inbound<$6)`
	} else {
		from += ` AND ($5::timestamptz IS NULL OR r.last_at>=$5) AND ($6::timestamptz IS NULL OR r.last_at<$6)`
	}
	return from, []any{identity(c).Tenant, platform, search, code, start, end}, true
}
func (a *App) teamLeads(c *gin.Context)     { a.teamCustomerList(c, true) }
func (a *App) teamCustomers(c *gin.Context) { a.teamCustomerList(c, false) }
func (a *App) teamCustomerList(c *gin.Context, leads bool) {
	from, args, valid := teamFilter(c, leads)
	if !valid {
		return
	}
	firstField := "r.first_at"
	if leads {
		firstField = "r.first_inbound"
	}
	a.commerceList(c, `COALESCE(r.account_id::text,'profile')||':'||r.platform||':'||r.customer_id AS id,r.customer_id AS customer,r.name,r.platform,COALESCE(r.account_id::text,'') AS "accountId",r.account_label AS "accountLabel",r.code_id AS "codeId",r.code_label AS "codeLabel",`+firstField+` AS "firstAt",r.last_at AS "lastAt",r.inbound,r.outbound,r.last_sync_at AS "lastSyncAt",COALESCE(r.collector_ready,false) AS "collectorReady",COALESCE(r.last_at,r.first_at,'1970-01-01'::timestamptz) AS "createdAt"`, from, args...)
}
func (a *App) teamOverview(c *gin.Context) {
	from, args, valid := teamFilter(c, c.Query("scope") == "leads")
	if !valid {
		return
	}
	var customers, newCustomers, inbound, outbound int64
	err := a.DB.QueryRow(c.Request.Context(), `SELECT count(*),count(*) FILTER(WHERE r.first_inbound IS NOT NULL),COALESCE(sum(r.inbound),0)::bigint,COALESCE(sum(r.outbound),0)::bigint`+from, args...).Scan(&customers, &newCustomers, &inbound, &outbound)
	if err != nil {
		dbError(c, err)
		return
	}
	ok(c, gin.H{"customers": customers, "newCustomers": newCustomers, "inbound": inbound, "outbound": outbound, "messages": inbound + outbound})
}
func (a *App) teamMessages(c *gin.Context) {
	id := identity(c)
	account, customer := c.Query("accountId"), c.Query("customer")
	ctx := c.Request.Context()
	var platform, connection string
	err := a.DB.QueryRow(ctx, `SELECT platform,connection_type FROM platform_accounts WHERE id::text=$1 AND tenant_id=$2`, account, id.Tenant).Scan(&platform, &connection)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 404, "账号不存在")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	if !validBillingIdentity(platform, customer) && !(platform == "whatsapp" && strings.HasPrefix(customer, "lid:") && workOrderCustomerID.MatchString(customer)) {
		fail(c, 400, "客户标识无效")
		return
	}
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("pageSize", "50"))
	if page < 1 {
		page = 1
	}
	if page > 100000 {
		page = 100000
	}
	if size < 1 || size > 100 {
		size = 50
	}
	var total int64
	err = a.DB.QueryRow(ctx, `SELECT count(*) FROM team_message_index WHERE tenant_id=$1 AND account_id::text=$2 AND customer_id=$3`, id.Tenant, account, customer).Scan(&total)
	if err != nil {
		dbError(c, err)
		return
	}
	rows, err := a.DB.Query(ctx, `SELECT id,direction,kind,body_cipher,body,truncated,at FROM team_message_index WHERE tenant_id=$1 AND account_id::text=$2 AND customer_id=$3 ORDER BY at DESC,id DESC LIMIT $4 OFFSET $5`, id.Tenant, account, customer, size, (page-1)*size)
	if err != nil {
		dbError(c, err)
		return
	}
	items := []gin.H{}
	for rows.Next() {
		var key, direction, kind, cipher, body string
		var truncated bool
		var at time.Time
		if err = rows.Scan(&key, &direction, &kind, &cipher, &body, &truncated, &at); err != nil {
			rows.Close()
			dbError(c, err)
			return
		}
		if cipher != "" {
			body, err = security.Open(a.Key, cipher)
			if err != nil {
				rows.Close()
				dbError(c, err)
				return
			}
		}
		items = append(items, gin.H{"id": key, "direction": direction, "kind": kind, "body": body, "truncated": truncated, "at": at})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		dbError(c, err)
		return
	}
	scope := "unavailable"
	var sync *time.Time
	var ready, limited bool
	if connection == "cloud" {
		scope = "cloud_retained"
		ready = true
	} else {
		err = a.DB.QueryRow(ctx, `SELECT history_scope,collector_ready,last_sync_at,limited FROM team_archive_sync WHERE tenant_id=$1 AND account_id::text=$2`, id.Tenant, account).Scan(&scope, &ready, &sync, &limited)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			dbError(c, err)
			return
		}
	}
	a.audit(c, id.Tenant, id.Actor, "team.messages.read", true)
	ok(c, gin.H{"items": items, "total": total, "page": page, "pageSize": size, "historyScope": scope, "collectorReady": ready, "lastSyncAt": sync, "limited": limited})
}

type archiveRecord struct {
	ID         string    `json:"id"`
	Customer   string    `json:"customer"`
	Name       string    `json:"name"`
	Direction  string    `json:"direction"`
	Body       string    `json:"body"`
	Kind       string    `json:"kind"`
	At         time.Time `json:"at"`
	ObservedAt time.Time `json:"observedAt"`
	Truncated  bool      `json:"truncated"`
}

func (a *App) ingestChatArchive(c *gin.Context) {
	var b struct {
		Owner        string          `json:"owner"`
		Ready        bool            `json:"ready"`
		HistoryScope string          `json:"historyScope"`
		Limited      bool            `json:"limited"`
		Messages     []archiveRecord `json:"messages"`
	}
	if c.Request.ContentLength > 1_500_000 {
		fail(c, 400, "同步内容过大")
		return
	}
	if c.ShouldBindJSON(&b) != nil || len(b.Messages) > 100 || (b.HistoryScope != "loaded_only" && b.HistoryScope != "unavailable") {
		fail(c, 400, "聊天同步格式无效")
		return
	}
	now := time.Now()
	kinds := map[string]bool{"text": true, "image": true, "video": true, "audio": true, "document": true, "sticker": true, "location": true, "contact": true, "poll": true}
	totalBytes := 0
	for i := range b.Messages {
		m := &b.Messages[i]
		totalBytes += len(m.Body)
		if m.ObservedAt.IsZero() {
			m.ObservedAt = now
		}
		if m.ID == "" || len(m.ID) > 512 || strings.ContainsRune(m.ID, '\x00') || len(m.Customer) > 80 || utf8.RuneCountInString(m.Name) > 150 || strings.ContainsRune(m.Name, '\x00') || (m.Direction != "in" && m.Direction != "out") || !kinds[m.Kind] || utf8.RuneCountInString(m.Body) > 8000 || len(m.Body) > 32000 || m.At.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || m.At.After(now.Add(5*time.Minute)) || m.ObservedAt.After(now.Add(5*time.Minute)) || m.ObservedAt.Before(m.At.Add(-5*time.Minute)) {
			fail(c, 400, "消息字段无效")
			return
		}
	}
	if totalBytes > 1_000_000 || (!b.Ready && len(b.Messages) > 0) {
		fail(c, 400, "同步批次无效")
		return
	}
	id := identity(c)
	ctx := c.Request.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		dbError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	var enabled bool
	err = tx.QueryRow(ctx, `SELECT enabled FROM team_supervision_settings WHERE tenant_id=$1 FOR SHARE`, id.Tenant).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !enabled {
		ok(c, gin.H{"accepted": 0, "enabled": false})
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	var platform, owner string
	err = tx.QueryRow(ctx, `SELECT a.platform,a.billing_identity FROM platform_accounts a JOIN login_codes l ON l.id=a.code_id AND l.tenant_id=a.tenant_id WHERE a.id::text=$1 AND a.tenant_id=$2 AND a.code_id=$3 AND a.device_id=$4 AND a.connection_type='web' AND a.removed_at IS NULL AND a.paused_at IS NULL AND a.platform=ANY(l.allowed_platforms) AND (a.proxy_id IS NULL OR EXISTS(SELECT 1 FROM proxies p WHERE p.id=a.proxy_id AND p.tenant_id=a.tenant_id AND p.enabled)) FOR SHARE OF a,l`, c.Param("id"), id.Tenant, id.Code, id.Device).Scan(&platform, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 404, "账号不可用")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	if owner == "" || owner != b.Owner || !validBillingIdentity(platform, b.Owner) {
		fail(c, 409, "账号身份尚未确认")
		return
	}
	for _, m := range b.Messages {
		if m.Customer == owner || (!validBillingIdentity(platform, m.Customer) && !(platform == "whatsapp" && strings.HasPrefix(m.Customer, "lid:") && workOrderCustomerID.MatchString(m.Customer))) {
			fail(c, 400, "客户标识与平台不符")
			return
		}
		cipher, e := security.Seal(a.Key, m.Body)
		if e != nil {
			dbError(c, e)
			return
		}
		result, writeErr := tx.Exec(ctx, `INSERT INTO team_chat_messages(tenant_id,account_id,message_id,customer_id,customer_name,direction,kind,body_cipher,truncated,occurred_at,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(account_id,message_id) DO UPDATE SET body_cipher=EXCLUDED.body_cipher,customer_name=EXCLUDED.customer_name,truncated=EXCLUDED.truncated,observed_at=EXCLUDED.observed_at WHERE team_chat_messages.observed_at<=EXCLUDED.observed_at AND team_chat_messages.customer_id=EXCLUDED.customer_id AND team_chat_messages.direction=EXCLUDED.direction`, id.Tenant, c.Param("id"), m.ID, m.Customer, m.Name, m.Direction, m.Kind, cipher, m.Truncated, m.At, m.ObservedAt)
		err = writeErr
		if err != nil {
			dbError(c, err)
			return
		}
		if result.RowsAffected() == 0 {
			var matches bool
			err = tx.QueryRow(ctx, `SELECT customer_id=$3 AND direction=$4 FROM team_chat_messages WHERE tenant_id=$1 AND account_id=$2 AND message_id=$5`, id.Tenant, c.Param("id"), m.Customer, m.Direction, m.ID).Scan(&matches)
			if err != nil {
				dbError(c, err)
				return
			}
			if !matches {
				fail(c, 409, "消息标识冲突，请重新同步")
				return
			}
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO team_archive_sync(tenant_id,account_id,collector_ready,history_scope,limited) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id) DO UPDATE SET collector_ready=EXCLUDED.collector_ready,history_scope=EXCLUDED.history_scope,limited=EXCLUDED.limited,last_sync_at=now()`, id.Tenant, c.Param("id"), b.Ready, b.HistoryScope, b.Limited)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		dbError(c, err)
		return
	}
	ok(c, gin.H{"accepted": len(b.Messages), "enabled": true})
}
