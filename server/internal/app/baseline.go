package app

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
	"strings"
	"unicode/utf8"
)

func (a *App) baselineRoutes(r *gin.RouterGroup) {
	r.GET("/baselines", a.listBaseline)
	r.GET("/baselines/summary", a.baselineSummary)
	r.POST("/baselines/preview", a.previewBaseline)
	r.POST("/baselines/import", a.importBaseline)
	r.GET("/baselines/batches", a.baselineBatches)
	r.PATCH("/baselines/:id", a.updateBaseline)
	r.POST("/baselines/check", a.checkCustomer)
	r.GET("/conversations", a.listConversations)
	r.POST("/conversations", a.recordAdminConversation)
	r.POST("/conversations/recalculate", a.recalculateConversations)
}
func baselineLock(ctx context.Context, tx pgx.Tx, tenant, platform string) error {
	_, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,7007006))`, tenant+":"+platform)
	return e
}
func (a *App) listBaseline(c *gin.Context) {
	a.commerceList(c, `b.id::text,b.platform,b.identifier,b.customer_ip AS ip,b.note,b.enabled,COALESCE(a.label,'') AS "accountName",COALESCE(b.account_id::text,'') AS "accountId",b.created_at AS "createdAt"`,
		`FROM baseline_entries b LEFT JOIN platform_accounts a ON a.id=b.account_id WHERE b.tenant_id=$1 AND ($2='' OR b.platform=$2) AND ($3='' OR b.identifier ILIKE '%'||$3||'%' OR b.customer_ip ILIKE '%'||$3||'%' OR b.note ILIKE '%'||$3||'%') AND ($4='' OR b.enabled::text=$4)`, identity(c).Tenant, c.Query("platform"), c.Query("search"), c.Query("enabled"))
}
func (a *App) baselineSummary(c *gin.Context) {
	var active, accounts, ips, total, newCount, repeated int64
	e := a.DB.QueryRow(c.Request.Context(), `SELECT count(*) FILTER(WHERE enabled),count(DISTINCT (platform,identifier)) FILTER(WHERE enabled AND identifier<>''),count(DISTINCT (platform,customer_ip)) FILTER(WHERE enabled AND customer_ip<>'') FROM baseline_entries WHERE tenant_id=$1`, identity(c).Tenant).Scan(&active, &accounts, &ips)
	if e != nil {
		dbError(c, e)
		return
	}
	e = a.DB.QueryRow(c.Request.Context(), `SELECT count(*),count(*) FILTER(WHERE NOT duplicate_account AND NOT duplicate_ip),count(*) FILTER(WHERE duplicate_account OR duplicate_ip) FROM customer_conversations WHERE tenant_id=$1`, identity(c).Tenant).Scan(&total, &newCount, &repeated)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"entries": active, "identifiers": accounts, "ips": ips, "conversations": total, "newUsers": newCount, "repeatedUsers": repeated})
}

type baselineInput struct {
	Platform  string `json:"platform"`
	AccountID string `json:"accountId"`
	Text      string `json:"text"`
	RequestID string `json:"requestId"`
	Source    string `json:"source"`
}

func readBaseline(c *gin.Context) (baselineInput, []baselineRow, bool) {
	var b baselineInput
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "导入参数无效")
		return b, nil, false
	}
	if b.Platform != "whatsapp" && b.Platform != "line" {
		fail(c, 400, "请选择 WhatsApp 或 LINE")
		return b, nil, false
	}
	rows, e := baselineRows(b.Platform, b.Text)
	if e != nil {
		fail(c, 400, e.Error())
		return b, nil, false
	}
	if b.Source == "" {
		b.Source = "粘贴导入"
	}
	b.Source = truncate(b.Source, 100)
	return b, rows, true
}
func baselineAccount(ctx context.Context, tx pgx.Tx, tenant, platform, account string) error {
	if account == "" {
		return nil
	}
	var valid bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_accounts WHERE id::text=$1 AND tenant_id=$2 AND platform=$3)`, account, tenant, platform).Scan(&valid); e != nil {
		return e
	}
	if !valid {
		return commerceError{400, "来源客服账号不属于当前团队或平台"}
	}
	return nil
}
func (a *App) previewBaseline(c *gin.Context) {
	b, rows, valid := readBaseline(c)
	if !valid {
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		if e := baselineAccount(c.Request.Context(), tx, identity(c).Tenant, b.Platform, b.AccountID); e != nil {
			return nil, e
		}
		seen := map[string]bool{}
		validCount, existing := 0, 0
		out := []gin.H{}
		for _, row := range rows {
			status := "新增"
			if row.Error != "" {
				status = "无效"
			} else {
				validCount++
				key := row.Identifier + "|" + row.IP
				var exists bool
				if e := tx.QueryRow(c.Request.Context(), `SELECT EXISTS(SELECT 1 FROM baseline_entries WHERE tenant_id=$1 AND platform=$2 AND identifier=$3 AND customer_ip=$4)`, identity(c).Tenant, b.Platform, row.Identifier, row.IP).Scan(&exists); e != nil {
					return nil, e
				}
				if exists || seen[key] {
					status = "跳过重复"
					existing++
				}
				seen[key] = true
			}
			out = append(out, gin.H{"line": row.Line, "identifier": row.Identifier, "ip": row.IP, "note": row.Note, "error": row.Error, "status": status})
		}
		return gin.H{"rows": out, "total": len(rows), "valid": validCount, "invalid": len(rows) - validCount, "added": validCount - existing, "skipped": existing}, nil
	})
}
func (a *App) importBaseline(c *gin.Context) {
	b, rows, valid := readBaseline(c)
	if !valid {
		return
	}
	if e := requestKey(b.RequestID); e != nil {
		commerceFail(c, e)
		return
	}
	fingerprint := security.Hash(b.Platform + "\x00" + b.AccountID + "\x00" + b.Text + "\x00" + b.Source)
	id := identity(c)
	ctx := c.Request.Context()
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		// Lock tenant import request as well as platform so reuse across platforms is safe.
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,7007007))`, id.Tenant+":"+b.RequestID); e != nil {
			return nil, e
		}
		var oldFingerprint, batch string
		var added, skipped, invalid int
		var oldErrors []byte
		e := tx.QueryRow(ctx, `SELECT id::text,fingerprint,added,skipped,invalid,errors FROM baseline_batches WHERE tenant_id=$1 AND request_id=$2`, id.Tenant, b.RequestID).Scan(&batch, &oldFingerprint, &added, &skipped, &invalid, &oldErrors)
		if e == nil {
			if oldFingerprint != fingerprint {
				return nil, businessError("请求编号已用于其他导入")
			}
			var errors any
			json.Unmarshal(oldErrors, &errors)
			return gin.H{"id": batch, "added": added, "skipped": skipped, "invalid": invalid, "errors": errors}, nil
		}
		if e != pgx.ErrNoRows {
			return nil, e
		}
		if e = baselineAccount(ctx, tx, id.Tenant, b.Platform, b.AccountID); e != nil {
			return nil, e
		}
		if e = baselineLock(ctx, tx, id.Tenant, b.Platform); e != nil {
			return nil, e
		}
		var account any
		if b.AccountID != "" {
			account = b.AccountID
		}
		errors := []baselineRow{}
		for _, row := range rows {
			if row.Error != "" {
				errors = append(errors, row)
			}
		}
		invalid = len(errors)
		if invalid == len(rows) {
			return nil, commerceError{400, "没有有效数据，请修正后导入"}
		}
		encoded, _ := json.Marshal(errors)
		e = tx.QueryRow(ctx, `INSERT INTO baseline_batches(tenant_id,request_id,fingerprint,platform,account_id,source,total,added,skipped,invalid,errors) VALUES($1,$2,$3,$4,$5,$6,$7,0,0,$8,$9) RETURNING id::text`, id.Tenant, b.RequestID, fingerprint, b.Platform, account, b.Source, len(rows), invalid, encoded).Scan(&batch)
		if e != nil {
			return nil, e
		}
		for _, row := range rows {
			if row.Error != "" {
				continue
			}
			result, e := tx.Exec(ctx, `INSERT INTO baseline_entries(tenant_id,platform,identifier,customer_ip,note,account_id,batch_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,platform,identifier,customer_ip) DO NOTHING`, id.Tenant, b.Platform, row.Identifier, row.IP, row.Note, account, batch)
			if e != nil {
				return nil, e
			}
			if result.RowsAffected() == 1 {
				added++
			} else {
				skipped++
			}
		}
		if _, e = tx.Exec(ctx, `UPDATE baseline_batches SET added=$2,skipped=$3 WHERE id=$1`, batch, added, skipped); e != nil {
			return nil, e
		}
		if e = auditTx(ctx, tx, c, id.Tenant, "baseline.import:"+batch); e != nil {
			return nil, e
		}
		return gin.H{"id": batch, "added": added, "skipped": skipped, "invalid": invalid, "errors": errors}, nil
	})
}
func (a *App) baselineBatches(c *gin.Context) {
	a.commerceList(c, `b.id::text,b.platform,b.source,b.total,b.added,b.skipped,b.invalid,b.errors,b.created_at AS "createdAt",COALESCE(a.label,'') AS "accountName"`,
		`FROM baseline_batches b LEFT JOIN platform_accounts a ON a.id=b.account_id WHERE b.tenant_id=$1 AND ($2='' OR b.platform=$2)`, identity(c).Tenant, c.Query("platform"))
}
func (a *App) updateBaseline(c *gin.Context) {
	var b struct {
		Enabled *bool   `json:"enabled"`
		Note    *string `json:"note"`
	}
	if c.ShouldBindJSON(&b) != nil || (b.Enabled == nil && b.Note == nil) || (b.Note != nil && utf8.RuneCountInString(*b.Note) > 200) {
		fail(c, 400, "参数无效，备注最多 200 字")
		return
	}
	id := identity(c)
	ctx := c.Request.Context()
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		var platform string
		if e := tx.QueryRow(ctx, `SELECT platform FROM baseline_entries WHERE id::text=$1 AND tenant_id=$2`, c.Param("id"), id.Tenant).Scan(&platform); e != nil {
			return nil, e
		}
		if e := baselineLock(ctx, tx, id.Tenant, platform); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, `UPDATE baseline_entries SET enabled=COALESCE($3,enabled),note=COALESCE($4,note) WHERE id::text=$1 AND tenant_id=$2`, c.Param("id"), id.Tenant, b.Enabled, b.Note); e != nil {
			return nil, e
		}
		return true, auditTx(ctx, tx, c, id.Tenant, "baseline.update:"+c.Param("id"))
	})
}

type customerInput struct {
	Platform   string `json:"platform"`
	AccountID  string `json:"accountId"`
	Identifier string `json:"identifier"`
	IP         string `json:"ip"`
}
type customerMatch struct {
	DuplicateAccount bool `json:"duplicateAccount"`
	DuplicateIP      bool `json:"duplicateIP"`
	BaselineMatch    bool `json:"baselineMatch"`
	HistoryMatch     bool `json:"historyMatch"`
}

func matchCustomer(ctx context.Context, tx pgx.Tx, tenant, platform, identifier, ip string, before int64) (customerMatch, error) {
	var m customerMatch
	var ba, bi, ha, hi bool
	e := tx.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM baseline_entries WHERE tenant_id=$1 AND platform=$2 AND enabled AND identifier=$3 AND $3<>''),
 EXISTS(SELECT 1 FROM baseline_entries WHERE tenant_id=$1 AND platform=$2 AND enabled AND customer_ip=$4 AND $4<>''),
 EXISTS(SELECT 1 FROM customer_conversations WHERE tenant_id=$1 AND platform=$2 AND identifier=$3 AND $3<>'' AND ($5=0 OR seq<$5)),
 EXISTS(SELECT 1 FROM customer_conversations WHERE tenant_id=$1 AND platform=$2 AND customer_ip=$4 AND $4<>'' AND ($5=0 OR seq<$5))`, tenant, platform, identifier, ip, before).Scan(&ba, &bi, &ha, &hi)
	m.DuplicateAccount = ba || ha
	m.DuplicateIP = bi || hi
	m.BaselineMatch = ba || bi
	m.HistoryMatch = ha || hi
	return m, e
}
func normalizeInput(b *customerInput) error {
	identifier, ip, e := normalizeCustomer(b.Platform, b.Identifier, b.IP)
	if e != nil {
		return commerceError{400, e.Error()}
	}
	b.Identifier = identifier
	b.IP = ip
	return nil
}
func (a *App) checkCustomer(c *gin.Context) {
	var b customerInput
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "查重参数无效")
		return
	}
	if e := normalizeInput(&b); e != nil {
		commerceFail(c, e)
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		return matchCustomer(c.Request.Context(), tx, identity(c).Tenant, b.Platform, b.Identifier, b.IP, 0)
	})
}
func (a *App) checkClientCustomer(c *gin.Context)      { a.clientCustomer(c, false) }
func (a *App) recordClientConversation(c *gin.Context) { a.clientCustomer(c, true) }
func (a *App) clientCustomer(c *gin.Context, record bool) {
	var b customerInput
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "客户参数无效")
		return
	}
	id := identity(c)
	ctx := c.Request.Context()
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		// Platform and ownership are obtained from server records, never renderer input.
		e := tx.QueryRow(ctx, `SELECT a.platform FROM platform_accounts a JOIN proxies p ON p.id=a.proxy_id WHERE a.id::text=$1 AND a.tenant_id=$2 AND a.code_id=$3 AND a.device_id=$4 AND p.enabled`, b.AccountID, id.Tenant, id.Code, id.Device).Scan(&b.Platform)
		if e != nil {
			return nil, e
		}
		if e = normalizeInput(&b); e != nil {
			return nil, e
		}
		if !record {
			// A current chat must not match itself after registration. Check the
			// current baseline and conversations preceding its stable sequence.
			var before int64
			if e := tx.QueryRow(ctx, `SELECT COALESCE((SELECT seq FROM customer_conversations WHERE tenant_id=$1 AND account_id=$2 AND identifier=$3),0)`, id.Tenant, b.AccountID, b.Identifier).Scan(&before); e != nil {
				return nil, e
			}
			return matchCustomer(ctx, tx, id.Tenant, b.Platform, b.Identifier, b.IP, before)
		}
		return recordConversation(ctx, tx, id.Tenant, b)
	})
}
func (a *App) recordAdminConversation(c *gin.Context) {
	var b customerInput
	if c.ShouldBindJSON(&b) != nil || b.AccountID == "" {
		fail(c, 400, "请选择来源客服账号")
		return
	}
	id := identity(c)
	ctx := c.Request.Context()
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		if e := tx.QueryRow(ctx, `SELECT platform FROM platform_accounts WHERE id::text=$1 AND tenant_id=$2`, b.AccountID, id.Tenant).Scan(&b.Platform); e != nil {
			return nil, e
		}
		if e := normalizeInput(&b); e != nil {
			return nil, e
		}
		result, e := recordConversation(ctx, tx, id.Tenant, b)
		if e != nil {
			return nil, e
		}
		return result, auditTx(ctx, tx, c, id.Tenant, "conversation.register")
	})
}
func recordConversation(ctx context.Context, tx pgx.Tx, tenant string, b customerInput) (any, error) {
	if b.Identifier == "" {
		return nil, commerceError{400, "登记对话必须填写客户账号，IP 仅作为辅助查重依据"}
	}
	if e := baselineLock(ctx, tx, tenant, b.Platform); e != nil {
		return nil, e
	}
	var id, ip string
	var old customerMatch
	e := tx.QueryRow(ctx, `SELECT id::text,customer_ip,duplicate_account,duplicate_ip,baseline_match,history_match FROM customer_conversations WHERE tenant_id=$1 AND account_id=$2 AND identifier=$3`, tenant, b.AccountID, b.Identifier).Scan(&id, &ip, &old.DuplicateAccount, &old.DuplicateIP, &old.BaselineMatch, &old.HistoryMatch)
	if e == nil {
		if b.IP != "" && b.IP != ip {
			return nil, businessError("该客户与客服的对话已登记；新增 IP 请在底库补充，随后重新计算")
		}
		return gin.H{"id": id, "existing": true, "match": old}, nil
	}
	if e != pgx.ErrNoRows {
		return nil, e
	}
	match, e := matchCustomer(ctx, tx, tenant, b.Platform, b.Identifier, b.IP, 0)
	if e != nil {
		return nil, e
	}
	e = tx.QueryRow(ctx, `INSERT INTO customer_conversations(tenant_id,account_id,platform,identifier,customer_ip,duplicate_account,duplicate_ip,baseline_match,history_match) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`, tenant, b.AccountID, b.Platform, b.Identifier, b.IP, match.DuplicateAccount, match.DuplicateIP, match.BaselineMatch, match.HistoryMatch).Scan(&id)
	return gin.H{"id": id, "existing": false, "match": match}, e
}
func (a *App) listConversations(c *gin.Context) {
	a.commerceList(c, `v.id::text,v.platform,v.identifier,v.customer_ip AS ip,a.label AS "accountName",v.duplicate_account AS "duplicateAccount",v.duplicate_ip AS "duplicateIP",v.baseline_match AS "baselineMatch",v.history_match AS "historyMatch",v.checked_at AS "checkedAt",v.created_at AS "createdAt"`,
		`FROM customer_conversations v JOIN platform_accounts a ON a.id=v.account_id WHERE v.tenant_id=$1 AND ($2='' OR v.platform=$2) AND ($3='' OR v.identifier ILIKE '%'||$3||'%' OR v.customer_ip ILIKE '%'||$3||'%' OR a.label ILIKE '%'||$3||'%') AND ($4='' OR (v.duplicate_account OR v.duplicate_ip)::text=$4)`, identity(c).Tenant, c.Query("platform"), strings.TrimSpace(c.Query("search")), c.Query("duplicate"))
}
func (a *App) recalculateConversations(c *gin.Context) {
	var b struct {
		Platform string `json:"platform"`
	}
	if c.ShouldBindJSON(&b) != nil || (b.Platform != "whatsapp" && b.Platform != "line") {
		fail(c, 400, "请选择要重新计算的平台")
		return
	}
	id := identity(c)
	ctx := c.Request.Context()
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		if e := baselineLock(ctx, tx, id.Tenant, b.Platform); e != nil {
			return nil, e
		}
		result, e := tx.Exec(ctx, `WITH matches AS (
   SELECT v.id,
   EXISTS(SELECT 1 FROM baseline_entries b WHERE b.tenant_id=v.tenant_id AND b.platform=v.platform AND b.enabled AND b.identifier=v.identifier AND b.identifier<>'') ba,
   EXISTS(SELECT 1 FROM baseline_entries b WHERE b.tenant_id=v.tenant_id AND b.platform=v.platform AND b.enabled AND b.customer_ip=v.customer_ip AND b.customer_ip<>'') bi,
   EXISTS(SELECT 1 FROM customer_conversations h WHERE h.tenant_id=v.tenant_id AND h.platform=v.platform AND h.identifier=v.identifier AND h.seq<v.seq) ha,
   EXISTS(SELECT 1 FROM customer_conversations h WHERE h.tenant_id=v.tenant_id AND h.platform=v.platform AND h.customer_ip=v.customer_ip AND h.customer_ip<>'' AND h.seq<v.seq) hi
   FROM customer_conversations v WHERE v.tenant_id=$1 AND v.platform=$2
  ) UPDATE customer_conversations v SET duplicate_account=m.ba OR m.ha,duplicate_ip=m.bi OR m.hi,baseline_match=m.ba OR m.bi,history_match=m.ha OR m.hi,checked_at=now() FROM matches m WHERE v.id=m.id`, id.Tenant, b.Platform)
		if e != nil {
			return nil, e
		}
		return gin.H{"updated": result.RowsAffected()}, auditTx(ctx, tx, c, id.Tenant, fmt.Sprintf("conversation.recalculate:%s", b.Platform))
	})
}
