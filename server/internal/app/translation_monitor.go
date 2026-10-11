package app

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/translation"
)

type translationProviderRow struct {
	translation.Provider
	Status      string     `json:"status"`
	Message     string     `json:"message"`
	CheckedAt   *time.Time `json:"checkedAt"`
	NextCheckAt *time.Time `json:"nextCheckAt"`
	LatencyMS   int64      `json:"latencyMs"`
	Requests    int64      `json:"requests"`
	InputChars  int64      `json:"inputChars"`
	OutputChars int64      `json:"outputChars"`
	LastUsedAt  *time.Time `json:"lastUsedAt"`
}

var checkMessages = map[string]string{
	"unknown":     "尚未检测",
	"checking":    "正在检测",
	"available":   "接口响应正常",
	"limited":     "接口限流，请稍后检测",
	"quota":       "免费额度已用完",
	"timeout":     "连接超时",
	"unavailable": "连接失败或未返回有效译文",
	"stale":       "检测结果已过期，请重新检测",
	"interrupted": "上次检测未完成，请重新检测",
}

func translationSince(c *gin.Context) (*time.Time, bool) {
	var duration time.Duration
	switch c.DefaultQuery("period", "24h") {
	case "24h":
		duration = 24 * time.Hour
	case "7d":
		duration = 7 * 24 * time.Hour
	case "30d":
		duration = 30 * 24 * time.Hour
	case "all":
		return nil, true
	default:
		fail(c, 400, "请选择有效的统计时间")
		return nil, false
	}
	since := time.Now().Add(-duration)
	return &since, true
}

func (a *App) translationProviders(c *gin.Context) {
	since, valid := translationSince(c)
	if !valid {
		return
	}
	ctx, tenant := c.Request.Context(), identity(c).Tenant
	items := make([]translationProviderRow, len(translation.Providers))
	byID := make(map[string]*translationProviderRow)
	for i, p := range translation.Providers {
		items[i] = translationProviderRow{Provider: p, Status: "unknown", Message: checkMessages["unknown"]}
		byID[p.ID] = &items[i]
	}
	rows, e := a.DB.Query(ctx, `SELECT provider,
 count(*) FILTER(WHERE $2::timestamptz IS NULL OR created_at >= $2),
 COALESCE(sum(input_chars) FILTER(WHERE $2::timestamptz IS NULL OR created_at >= $2),0),
 COALESCE(sum(output_chars) FILTER(WHERE $2::timestamptz IS NULL OR created_at >= $2),0),
 max(created_at) FROM usage_records WHERE tenant_id=$1 GROUP BY provider`, tenant, since)
	if e != nil {
		dbError(c, e)
		return
	}
	for rows.Next() {
		var provider string
		var requests, input, output int64
		var last *time.Time
		if e = rows.Scan(&provider, &requests, &input, &output, &last); e != nil {
			rows.Close()
			dbError(c, e)
			return
		}
		if row := byID[provider]; row != nil {
			row.Requests = requests
			row.InputChars = input
			row.OutputChars = output
			row.LastUsedAt = last
		}
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	rows, e = a.DB.Query(ctx, `SELECT provider,status,started_at,checked_at,latency_ms FROM translation_provider_checks WHERE tenant_id=$1`, tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var provider, status string
		var started time.Time
		var checked *time.Time
		var latency int64
		if e = rows.Scan(&provider, &status, &started, &checked, &latency); e != nil {
			dbError(c, e)
			return
		}
		row := byID[provider]
		if row == nil {
			continue
		}
		next := started.Add(time.Minute)
		row.CheckedAt, row.NextCheckAt, row.LatencyMS = checked, &next, latency
		if status == "checking" && time.Since(started) > 30*time.Second {
			status = "interrupted"
		}
		if checked != nil && time.Since(*checked) > 15*time.Minute {
			status = "stale"
		}
		row.Status, row.Message = status, checkMessages[status]
	}
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"items": items, "period": c.DefaultQuery("period", "24h")})
}

func (a *App) checkTranslationProvider(c *gin.Context) {
	provider, tenant := c.Param("provider"), identity(c).Tenant
	if !translation.KnownProvider(provider) {
		fail(c, 404, "翻译接口不存在")
		return
	}
	var started time.Time
	e := a.DB.QueryRow(c.Request.Context(), `INSERT INTO translation_provider_checks(tenant_id,provider,status) VALUES($1,$2,'checking')
 ON CONFLICT(tenant_id,provider) DO UPDATE SET status='checking',started_at=now(),checked_at=NULL,latency_ms=0
 WHERE translation_provider_checks.started_at <= now()-interval '60 seconds' RETURNING started_at`, tenant, provider).Scan(&started)
	if errors.Is(e, pgx.ErrNoRows) {
		fail(c, 429, "该接口每分钟可检测一次，请稍后重试")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	result, e := translation.Probe(c.Request.Context(), a.TranslationHTTP, provider)
	if e != nil {
		fail(c, 400, "翻译接口参数无效")
		return
	}
	// Save a bounded, sanitized result even when the browser closes mid-check.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), 3*time.Second)
	defer cancel()
	_, e = a.DB.Exec(ctx, `UPDATE translation_provider_checks SET status=$3,checked_at=$4,latency_ms=$5 WHERE tenant_id=$1 AND provider=$2 AND started_at=$6`, tenant, provider, result.Status, result.CheckedAt, result.LatencyMS, started)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"status": result.Status, "message": checkMessages[result.Status], "checkedAt": result.CheckedAt, "latencyMs": result.LatencyMS})
}

func (a *App) translationUsage(c *gin.Context) {
	since, valid := translationSince(c)
	if !valid {
		return
	}
	provider, channel, search := c.Query("provider"), c.Query("channel"), strings.TrimSpace(c.Query("search"))
	if (provider != "" && !translation.KnownProvider(provider)) || (channel != "" && channel != "web" && channel != "cloud") || utf8.RuneCountInString(search) > 100 {
		fail(c, 400, "使用记录筛选条件无效")
		return
	}
	a.commerceList(c, `u.id::text,a.label AS "accountName",
 CASE u.provider WHEN 'google-free' THEN 'Google' WHEN 'mymemory' THEN 'MyMemory' ELSE 'LibreTranslate' END AS "providerName",
 CASE a.connection_type WHEN 'cloud' THEN 'WhatsApp API' ELSE '客户端' END AS channel,
 u.input_chars AS "inputChars",u.output_chars AS "outputChars",u.target_language AS "targetLanguage",u.created_at AS "createdAt"`,
		`FROM usage_records u JOIN platform_accounts a ON a.id=u.account_id WHERE u.tenant_id=$1
 AND ($2::timestamptz IS NULL OR u.created_at >= $2) AND ($3='' OR u.provider=$3)
 AND ($4='' OR a.connection_type=$4) AND ($5='' OR a.label ILIKE '%'||$5||'%')`, identity(c).Tenant, since, provider, channel, search)
}
