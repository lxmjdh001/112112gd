package app

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
	"gongdan007/server/internal/security"
)

type workOrder struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	AccountIDs    []string   `json:"accountIds"`
	StartAt       time.Time  `json:"startAt"`
	EndAt         *time.Time `json:"endAt"`
	ResetMinutes  int        `json:"resetMinutes"`
	Target        int        `json:"target"`
	DedupBaseline bool       `json:"dedupBaseline"`
	Enabled       bool       `json:"enabled"`
	ExpiresAt     *time.Time `json:"expiresAt"`
	HasPassword   bool       `json:"hasPassword"`
	Token         string     `json:"token,omitempty"`
	Password      *string    `json:"password,omitempty"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

func (a *App) workOrderRoutes(v, admin, client *gin.RouterGroup) {
	admin.GET("/work-orders/options", a.workOrderOptions)
	admin.GET("/work-orders", a.listWorkOrders)
	admin.POST("/work-orders", a.saveWorkOrder)
	admin.PUT("/work-orders/:id", a.saveWorkOrder)
	admin.GET("/work-orders/:id/stats", a.memberWorkOrderStats)
	admin.POST("/work-orders/:id/rotate", a.rotateWorkOrderLink)
	admin.DELETE("/work-orders/:id", a.deleteWorkOrder)
	v.POST("/public/work-orders/:token", a.rate, a.publicWorkOrderStats)
	client.POST("/accounts/:id/inbound-events", a.ingestInboundEvents)
}
func (a *App) workOrderOptions(c *gin.Context) {
	rows, e := a.DB.Query(c.Request.Context(), `SELECT p.id::text,p.label,p.platform,p.connection_type,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'label',l.label,'groupId',COALESCE(l.group_id::text,''),'groupName',COALESCE(g.name,'未分组'))) FROM login_codes l LEFT JOIN login_code_groups g ON g.id=l.group_id AND g.tenant_id=l.tenant_id WHERE l.tenant_id=p.tenant_id AND l.deleted_at IS NULL AND (l.id=p.code_id OR EXISTS(SELECT 1 FROM wa_cloud_assignments x WHERE x.tenant_id=p.tenant_id AND x.number_id=p.id AND x.code_id=l.id))),'[]')
 FROM platform_accounts p WHERE p.tenant_id=$1 AND p.removed_at IS NULL ORDER BY p.created_at,p.id`, identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, label, platform, connection string
		var codes json.RawMessage
		if e = rows.Scan(&id, &label, &platform, &connection, &codes); e != nil {
			dbError(c, e)
			return
		}
		out = append(out, gin.H{"id": id, "label": label, "platform": platform, "connectionType": connection, "codes": codes})
	}
	if rows.Err() != nil {
		dbError(c, rows.Err())
		return
	}
	ok(c, out)
}
func (a *App) listWorkOrders(c *gin.Context) {
	rows, e := a.DB.Query(c.Request.Context(), `SELECT w.id::text,w.name,w.start_at,w.end_at,w.reset_minutes,w.target,w.dedup_baseline,w.enabled,w.expires_at,w.password_hash<>'',w.token_cipher,w.updated_at,ARRAY(SELECT account_id::text FROM work_order_accounts x WHERE x.order_id=w.id ORDER BY account_id) FROM work_orders w WHERE tenant_id=$1 ORDER BY created_at DESC`, identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []workOrder{}
	for rows.Next() {
		var w workOrder
		var cipher string
		if e = rows.Scan(&w.ID, &w.Name, &w.StartAt, &w.EndAt, &w.ResetMinutes, &w.Target, &w.DedupBaseline, &w.Enabled, &w.ExpiresAt, &w.HasPassword, &cipher, &w.UpdatedAt, &w.AccountIDs); e != nil {
			dbError(c, e)
			return
		}
		w.Token, e = security.Open(a.Key, cipher)
		if e != nil {
			dbError(c, e)
			return
		}
		out = append(out, w)
	}
	if rows.Err() != nil {
		dbError(c, rows.Err())
		return
	}
	ok(c, out)
}
func (a *App) saveWorkOrder(c *gin.Context) {
	var w workOrder
	if c.ShouldBindJSON(&w) != nil {
		fail(c, 400, "请检查工单设置")
		return
	}
	w.ID = "" // The route, never request JSON, determines the record being edited.
	w.Name = strings.TrimSpace(w.Name)
	if w.Name == "" || utf8.RuneCountInString(w.Name) > 80 || len(w.AccountIDs) == 0 || len(w.AccountIDs) > 500 || w.StartAt.Year() < 2000 || w.StartAt.Year() > 2099 || w.EndAt != nil && w.EndAt.Before(w.StartAt) || w.ResetMinutes < 0 || w.ResetMinutes > 1439 || w.Target < 0 || w.Target > 100000000 {
		fail(c, 400, "填写工单名称、有效统计时间，并选择 1–500 个账号")
		return
	}
	if w.Password != nil && *w.Password != "" && (len(*w.Password) < 4 || len(*w.Password) > 72) {
		fail(c, 400, "访问密码须为 4–72 字节")
		return
	}
	ids := map[string]bool{}
	for _, s := range w.AccountIDs {
		if len(s) != 36 || ids[s] {
			fail(c, 400, "账号选择无效")
			return
		}
		ids[s] = true
	}
	ctx := c.Request.Context()
	tenant := identity(c).Tenant
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		dbError(c, e)
		return
	}
	defer tx.Rollback(ctx)
	var passwordHash string
	if c.Param("id") != "" {
		e = tx.QueryRow(ctx, `SELECT id::text,password_hash FROM work_orders WHERE id::text=$1 AND tenant_id=$2 FOR UPDATE`, c.Param("id"), tenant).Scan(&w.ID, &passwordHash)
		if e == pgx.ErrNoRows {
			fail(c, 404, "工单不存在")
			return
		}
		if e != nil {
			dbError(c, e)
			return
		}
	}
	var count int
	e = tx.QueryRow(ctx, `SELECT count(*) FROM platform_accounts p WHERE p.tenant_id=$1 AND p.id::text=ANY($2) AND (p.removed_at IS NULL OR EXISTS(SELECT 1 FROM work_order_accounts x WHERE x.order_id::text=$3 AND x.account_id=p.id AND x.tenant_id=p.tenant_id))`, tenant, w.AccountIDs, w.ID).Scan(&count)
	if e != nil {
		dbError(c, e)
		return
	}
	if count != len(w.AccountIDs) {
		fail(c, 400, "部分账号已移除或不属于当前公司")
		return
	}
	if w.Password != nil {
		passwordHash = ""
		if *w.Password != "" {
			hash, err := bcrypt.GenerateFromPassword([]byte(*w.Password), bcrypt.DefaultCost)
			if err != nil {
				dbError(c, err)
				return
			}
			passwordHash = string(hash)
		}
	}
	if w.ID == "" {
		token := security.Token()
		cipher, err := security.Seal(a.Key, token)
		if err != nil {
			dbError(c, err)
			return
		}
		e = tx.QueryRow(ctx, `INSERT INTO work_orders(tenant_id,name,start_at,end_at,reset_minutes,target,dedup_baseline,enabled,expires_at,password_hash,token_hash,token_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::text`, tenant, w.Name, w.StartAt, w.EndAt, w.ResetMinutes, w.Target, w.DedupBaseline, w.Enabled, w.ExpiresAt, passwordHash, security.Hash(token), cipher).Scan(&w.ID)
	} else {
		_, e = tx.Exec(ctx, `UPDATE work_orders SET name=$3,start_at=$4,end_at=$5,reset_minutes=$6,target=$7,dedup_baseline=$8,enabled=$9,expires_at=$10,password_hash=$11,updated_at=now() WHERE id=$1 AND tenant_id=$2`, w.ID, tenant, w.Name, w.StartAt, w.EndAt, w.ResetMinutes, w.Target, w.DedupBaseline, w.Enabled, w.ExpiresAt, passwordHash)
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if _, e = tx.Exec(ctx, `DELETE FROM work_order_accounts WHERE order_id=$1`, w.ID); e != nil {
		dbError(c, e)
		return
	}
	for _, id := range w.AccountIDs {
		if _, e = tx.Exec(ctx, `INSERT INTO work_order_accounts(tenant_id,order_id,account_id) VALUES($1,$2,$3)`, tenant, w.ID, id); e != nil {
			dbError(c, e)
			return
		}
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, tenant, identity(c).Actor, "work-order.save", true)
	ok(c, gin.H{"id": w.ID})
}
func (a *App) rotateWorkOrderLink(c *gin.Context) {
	token := security.Token()
	cipher, e := security.Seal(a.Key, token)
	if e != nil {
		dbError(c, e)
		return
	}
	r, e := a.DB.Exec(c.Request.Context(), `UPDATE work_orders SET token_hash=$3,token_cipher=$4,updated_at=now() WHERE id::text=$1 AND tenant_id=$2`, c.Param("id"), identity(c).Tenant, security.Hash(token), cipher)
	if e != nil {
		dbError(c, e)
		return
	}
	if r.RowsAffected() == 0 {
		fail(c, 404, "工单不存在")
		return
	}
	ok(c, gin.H{"token": token})
}
func (a *App) deleteWorkOrder(c *gin.Context) {
	r, e := a.DB.Exec(c.Request.Context(), `DELETE FROM work_orders WHERE id::text=$1 AND tenant_id=$2`, c.Param("id"), identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	if r.RowsAffected() == 0 {
		fail(c, 404, "工单不存在")
		return
	}
	ok(c, gin.H{"deleted": true})
}
func (a *App) memberWorkOrderStats(c *gin.Context) {
	a.renderWorkOrderStats(c, identity(c).Tenant, c.Param("id"))
}
func (a *App) publicWorkOrderStats(c *gin.Context) {
	if len(c.Param("token")) != 43 {
		fail(c, 404, "统计链接不存在或已停用")
		return
	}
	var b struct {
		Password string `json:"password"`
	}
	if c.ShouldBindJSON(&b) != nil || len(b.Password) > 72 {
		fail(c, 400, "请求无效")
		return
	}
	var tenant, id, hash string
	e := a.DB.QueryRow(c.Request.Context(), `SELECT tenant_id::text,id::text,password_hash FROM work_orders WHERE token_hash=$1 AND enabled AND (expires_at IS NULL OR expires_at>now())`, security.Hash(c.Param("token"))).Scan(&tenant, &id, &hash)
	if e == pgx.ErrNoRows {
		fail(c, 404, "统计链接不存在、已停用或已到期")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if hash != "" && bcrypt.CompareHashAndPassword([]byte(hash), []byte(b.Password)) != nil {
		fail(c, 403, "请输入正确的访问密码")
		return
	}
	a.renderWorkOrderStats(c, tenant, id)
}

var workOrderCustomerID = regexp.MustCompile(`^(?:[0-9]{5,20}|lid:[0-9]{5,25}|u[0-9a-f]{32})$`)

func (a *App) ingestInboundEvents(c *gin.Context) {
	var b struct {
		Owner  string `json:"owner"`
		Ready  bool   `json:"ready"`
		Events []struct {
			ID       string    `json:"id"`
			Customer string    `json:"customer"`
			At       time.Time `json:"at"`
		} `json:"events"`
	}
	if c.ShouldBindJSON(&b) != nil || len(b.Events) > 250 {
		fail(c, 400, "统计数据格式无效")
		return
	}
	for _, v := range b.Events {
		if len(v.ID) == 0 || len(v.ID) > 512 || !workOrderCustomerID.MatchString(v.Customer) || v.At.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || v.At.After(time.Now().Add(5*time.Minute)) {
			fail(c, 400, "消息标识或时间无效")
			return
		}
	}
	id := identity(c)
	ctx := c.Request.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		dbError(c, e)
		return
	}
	defer tx.Rollback(ctx)
	var account, platform, owner string
	e = tx.QueryRow(ctx, `SELECT id::text,platform,billing_identity FROM platform_accounts WHERE id::text=$1 AND tenant_id=$2 AND code_id=$3 AND device_id=$4 AND connection_type='web' AND removed_at IS NULL AND paused_at IS NULL AND EXISTS(SELECT 1 FROM login_codes l WHERE l.id=code_id AND platform=ANY(l.allowed_platforms)) FOR UPDATE`, c.Param("id"), id.Tenant, id.Code, id.Device).Scan(&account, &platform, &owner)
	if e == pgx.ErrNoRows {
		fail(c, 404, "账号不可用")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if owner == "" || owner != b.Owner || !validBillingIdentity(platform, b.Owner) {
		fail(c, 409, "账号身份尚未确认，请等待状态同步")
		return
	}
	for _, v := range b.Events {
		valid := validBillingIdentity(platform, v.Customer) || (platform == "whatsapp" && strings.HasPrefix(v.Customer, "lid:"))
		if !valid || v.Customer == owner {
			fail(c, 400, "客户标识与平台不符")
			return
		}
		if _, e = tx.Exec(ctx, `INSERT INTO account_inbound_events(tenant_id,account_id,event_id,customer_id,occurred_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,event_id) DO NOTHING`, id.Tenant, account, v.ID, v.Customer, v.At); e != nil {
			dbError(c, e)
			return
		}
	}
	_, e = tx.Exec(ctx, `INSERT INTO account_stats_sync(tenant_id,account_id,collector_ready) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET last_sync_at=now(),collector_ready=EXCLUDED.collector_ready`, id.Tenant, account, b.Ready)
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"accepted": len(b.Events)})
}

type workOrderCount struct {
	Total     int `json:"total"`
	Today     int `json:"today"`
	Yesterday int `json:"yesterday"`
	Fresh     int `json:"fresh"`
	Duplicate int `json:"duplicate"`
}
type workOrderAccountStats struct {
	ID             string     `json:"id"`
	Label          string     `json:"label"`
	Platform       string     `json:"platform"`
	ConnectionType string     `json:"connectionType"`
	Removed        bool       `json:"removed"`
	LastSync       *time.Time `json:"lastSync"`
	FirstSync      *time.Time `json:"firstSync"`
	CollectorReady bool       `json:"collectorReady"`
	LastInbound    *time.Time `json:"lastInbound"`
	workOrderCount
}
type workOrderStats struct {
	Name         string     `json:"name"`
	StartAt      time.Time  `json:"startAt"`
	EndAt        *time.Time `json:"endAt"`
	ResetMinutes int        `json:"resetMinutes"`
	Target       int        `json:"target"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	workOrderCount
	Accounts []workOrderAccountStats `json:"accounts"`
}

func workOrderDayStart(now time.Time, reset int) time.Time {
	local := now.In(time.FixedZone("Beijing", 8*3600)).Add(-time.Duration(reset) * time.Minute)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location()).Add(time.Duration(reset) * time.Minute)
}
func (a *App) renderWorkOrderStats(c *gin.Context, tenant, id string) {
	result, e := a.calculateWorkOrderStats(c.Request.Context(), tenant, id, time.Now())
	if errors.Is(e, pgx.ErrNoRows) {
		fail(c, 404, "工单不存在")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, result)
}
func (a *App) calculateWorkOrderStats(ctx context.Context, tenant, id string, now time.Time) (workOrderStats, error) {
	s := workOrderStats{Accounts: []workOrderAccountStats{}, UpdatedAt: now}
	var baseline bool
	// Repeatable read prevents account selection edits or incoming messages from mixing snapshots.
	tx, e := a.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return s, e
	}
	defer tx.Rollback(ctx)
	e = tx.QueryRow(ctx, `SELECT name,start_at,end_at,reset_minutes,target,dedup_baseline FROM work_orders WHERE tenant_id=$1 AND id::text=$2`, tenant, id).Scan(&s.Name, &s.StartAt, &s.EndAt, &s.ResetMinutes, &s.Target, &baseline)
	if e != nil {
		return s, e
	}
	rows, e := tx.Query(ctx, `SELECT p.id::text,p.label,p.platform,p.connection_type,p.removed_at IS NOT NULL,CASE WHEN p.connection_type='cloud' THEN app.last_event_at ELSE sync.last_sync_at END,sync.first_sync_at,CASE WHEN p.connection_type='cloud' THEN app.verified_at IS NOT NULL ELSE COALESCE(sync.collector_ready,false) END FROM work_order_accounts x JOIN platform_accounts p ON p.id=x.account_id AND p.tenant_id=x.tenant_id LEFT JOIN account_stats_sync sync ON sync.account_id=p.id LEFT JOIN wa_cloud_numbers n ON n.id=p.id LEFT JOIN wa_cloud_apps app ON app.id=n.app_id WHERE x.tenant_id=$1 AND x.order_id::text=$2 ORDER BY p.created_at,p.id`, tenant, id)
	if e != nil {
		return s, e
	}
	indices := map[string]int{}
	for rows.Next() {
		var v workOrderAccountStats
		if e = rows.Scan(&v.ID, &v.Label, &v.Platform, &v.ConnectionType, &v.Removed, &v.LastSync, &v.FirstSync, &v.CollectorReady); e != nil {
			rows.Close()
			return s, e
		}
		indices[v.ID] = len(s.Accounts)
		s.Accounts = append(s.Accounts, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return s, e
	}
	// Match legacy: first inbound within this work order window, per account/contact.
	// System/group messages never enter the native event table; Cloud API chats are individual.
	rows, e = tx.Query(ctx, `WITH incoming AS (
 SELECT e.account_id,e.customer_id,e.occurred_at FROM account_inbound_events e JOIN work_order_accounts x ON x.account_id=e.account_id AND x.tenant_id=e.tenant_id WHERE e.tenant_id=$1 AND x.order_id::text=$2 AND e.occurred_at>=$3 AND e.occurred_at<=COALESCE($4::timestamptz,$5::timestamptz) AND e.occurred_at<=$5
 UNION ALL
 SELECT m.number_id,ch.customer_id,m.occurred_at FROM wa_cloud_messages m JOIN wa_cloud_chats ch ON ch.id=m.chat_id JOIN work_order_accounts x ON x.account_id=m.number_id AND x.tenant_id=m.tenant_id WHERE m.tenant_id=$1 AND x.order_id::text=$2 AND m.direction='in' AND m.kind NOT IN ('system','unsupported','unknown') AND m.occurred_at>=$3 AND m.occurred_at<=COALESCE($4::timestamptz,$5::timestamptz) AND m.occurred_at<=$5
 ), leads AS (SELECT account_id,customer_id,min(occurred_at) AS first_at,max(occurred_at) AS last_at FROM incoming GROUP BY account_id,customer_id)
 SELECT l.account_id::text,p.platform,l.customer_id,l.first_at,l.last_at,EXISTS(SELECT 1 FROM baseline_entries b WHERE b.tenant_id=$1 AND b.enabled AND b.platform=p.platform AND b.identifier=l.customer_id) FROM leads l JOIN platform_accounts p ON p.id=l.account_id ORDER BY first_at,account_id,customer_id`, tenant, id, s.StartAt, s.EndAt, now)
	if e != nil {
		return s, e
	}
	seen := map[string]bool{}
	today := workOrderDayStart(now, s.ResetMinutes)
	yesterday := today.Add(-24 * time.Hour)
	for rows.Next() {
		var account, platform, customer string
		var first, last time.Time
		var matched bool
		if e = rows.Scan(&account, &platform, &customer, &first, &last, &matched); e != nil {
			rows.Close()
			return s, e
		}
		index, found := indices[account]
		if !found {
			continue
		}
		v := &s.Accounts[index]
		key := platform + ":" + customer
		dup := seen[key] || baseline && matched
		seen[key] = true
		for _, counts := range []*workOrderCount{&v.workOrderCount, &s.workOrderCount} {
			counts.Total++
			if dup {
				counts.Duplicate++
			} else {
				counts.Fresh++
			}
			if !first.Before(today) {
				counts.Today++
			} else if !first.Before(yesterday) {
				counts.Yesterday++
			}
		}
		if v.LastInbound == nil || last.After(*v.LastInbound) {
			t := last
			v.LastInbound = &t
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return s, e
	}
	return s, tx.Commit(ctx)
}
