package app

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
	"time"
)

func (a *App) listAccounts(c *gin.Context) {
	rows, e := a.DB.Query(c.Request.Context(), `SELECT a.id::text,a.label,a.platform,l.label,p.host,p.port,a.observed_status,a.observed_at,COALESCE(d.name,''),COALESCE(d.active,false),d.last_seen,p.enabled,a.platform=ANY(l.allowed_platforms),l.deleted_at IS NOT NULL FROM platform_accounts a JOIN login_codes l ON a.code_id=l.id JOIN proxies p ON p.id=a.proxy_id LEFT JOIN devices d ON d.id=a.device_id WHERE a.tenant_id=$1 ORDER BY a.created_at DESC`, identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, label, platform, code, host, state, device string
		var port int
		var at, seen *time.Time
		var active, proxyEnabled, platformAllowed, codeDeleted bool
		if e = rows.Scan(&id, &label, &platform, &code, &host, &port, &state, &at, &device, &active, &seen, &proxyEnabled, &platformAllowed, &codeDeleted); e != nil {
			dbError(c, e)
			return
		}
		if state != "not_opened" && (at == nil || time.Since(*at) > 90*time.Second || !active || seen == nil || time.Since(*seen) > 90*time.Second) {
			state = "stale"
		}
		if !proxyEnabled {
			state = "proxy_disabled"
		}
		if !platformAllowed {
			state = "platform_not_allowed"
		}
		if codeDeleted {
			state = "code_deleted"
		}
		out = append(out, gin.H{"id": id, "label": label, "platform": platform, "codeLabel": code, "proxyHost": host, "proxyPort": port, "status": state, "observedAt": at, "deviceName": device})
	}
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	cloud, e := a.cloudAccountRows(c, false)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, append(out, cloud...))
}
func (a *App) clientAccounts(c *gin.Context) {
	id := identity(c)
	rows, e := a.DB.Query(c.Request.Context(), `SELECT a.id::text,a.label,a.platform,p.host,p.port,COALESCE(a.device_id::text,''),p.enabled,a.platform=ANY(l.allowed_platforms) FROM platform_accounts a JOIN proxies p ON p.id=a.proxy_id JOIN login_codes l ON l.id=a.code_id WHERE a.tenant_id=$1 AND a.code_id=$2 AND l.deleted_at IS NULL ORDER BY a.created_at`, id.Tenant, id.Code)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var key, label, platform, host, device string
		var port int
		var enabled, platformAllowed bool
		if e = rows.Scan(&key, &label, &platform, &host, &port, &device, &enabled, &platformAllowed); e != nil {
			dbError(c, e)
			return
		}
		reason := ""
		if !platformAllowed {
			reason = "platform_not_allowed"
		} else if !enabled {
			reason = "proxy_disabled"
		} else if device != "" && device != id.Device {
			reason = "other_device"
		}
		out = append(out, gin.H{"id": key, "label": label, "platform": platform, "proxyHost": host, "proxyPort": port, "available": reason == "", "unavailableReason": reason})
	}
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	cloud, e := a.cloudAccountRows(c, true)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, append(out, cloud...))
}
func (a *App) openAccount(c *gin.Context) {
	id := identity(c)
	ctx := c.Request.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		dbError(c, e)
		return
	}
	defer tx.Rollback(ctx)
	var grants []string
	e = tx.QueryRow(ctx, `SELECT allowed_platforms FROM login_codes WHERE id=$1 AND tenant_id=$2 AND enabled AND deleted_at IS NULL AND expires_at>now() FOR SHARE`, id.Code, id.Tenant).Scan(&grants)
	if errors.Is(e, pgx.ErrNoRows) {
		fail(c, 401, "登录码已停用或到期")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	var account, device, protocol, host, user, cipher string
	var port int
	e = tx.QueryRow(ctx, `SELECT a.id::text,COALESCE(a.device_id::text,''),p.protocol,p.host,p.port,p.username,p.password_cipher FROM platform_accounts a JOIN proxies p ON p.id=a.proxy_id WHERE a.id::text=$1 AND a.tenant_id=$2 AND a.code_id=$3 AND p.enabled AND a.platform=ANY($4::text[]) FOR UPDATE OF a`, c.Param("id"), id.Tenant, id.Code, grants).Scan(&account, &device, &protocol, &host, &port, &user, &cipher)
	if errors.Is(e, pgx.ErrNoRows) {
		fail(c, 404, "账号、平台授权或代理不可用")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if device != "" && device != id.Device {
		fail(c, 409, "该账号已绑定其他设备，请管理员先解绑；新设备需重新扫码")
		return
	}
	password, e := security.Open(a.Key, cipher)
	if e != nil {
		dbError(c, e)
		return
	}
	if _, e = tx.Exec(ctx, `UPDATE platform_accounts SET device_id=$1 WHERE id=$2`, id.Device, account); e != nil {
		dbError(c, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"id": account, "tenantId": id.Tenant, "proxy": gin.H{"protocol": protocol, "host": host, "port": port, "username": user, "password": password}})
}
func (a *App) accountStatus(c *gin.Context) {
	var b struct {
		Status string `json:"status"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "状态无效")
		return
	}
	switch b.Status {
	case "loading", "qr_required", "ready", "network_error", "unknown", "closed":
	default:
		fail(c, 400, "状态无效")
		return
	}
	id := identity(c)
	r, e := a.DB.Exec(c.Request.Context(), `UPDATE platform_accounts SET observed_status=$1,observed_at=now() WHERE id::text=$2 AND tenant_id=$3 AND code_id=$4 AND device_id=$5 AND EXISTS(SELECT 1 FROM proxies p WHERE p.id=platform_accounts.proxy_id AND p.enabled) AND EXISTS(SELECT 1 FROM login_codes l WHERE l.id=platform_accounts.code_id AND l.deleted_at IS NULL AND l.enabled AND platform_accounts.platform=ANY(l.allowed_platforms))`, b.Status, c.Param("id"), id.Tenant, id.Code, id.Device)
	if e != nil {
		dbError(c, e)
		return
	}
	if r.RowsAffected() == 0 {
		fail(c, 404, "账号不属于当前设备")
		return
	}
	ok(c, true)
}
