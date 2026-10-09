package app

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
	"time"
)

type codeInput struct {
	Label       string    `json:"label"`
	ExpiresAt   time.Time `json:"expiresAt"`
	MaxDevices  int       `json:"maxDevices"`
	MaxAccounts int       `json:"maxAccounts"`
	Enabled     bool      `json:"enabled"`
}

func (b codeInput) valid() bool {
	return len(b.Label) > 0 && len(b.Label) <= 100 && b.ExpiresAt.After(time.Now()) && b.MaxDevices > 0 && b.MaxDevices <= 100 && b.MaxAccounts > 0 && b.MaxAccounts <= 500
}
func (a *App) listCodes(c *gin.Context) {
	rows, e := a.DB.Query(c.Request.Context(), `SELECT l.id::text,label,suffix,enabled,expires_at,max_devices,max_accounts,created_at,(SELECT count(*) FROM devices d WHERE d.code_id=l.id AND d.active),(SELECT count(*) FROM platform_accounts p WHERE p.code_id=l.id) FROM login_codes l WHERE tenant_id=$1 ORDER BY created_at DESC`, identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, label, suffix string
		var enabled bool
		var expires, created time.Time
		var maxD, maxA, devices, accounts int
		if e = rows.Scan(&id, &label, &suffix, &enabled, &expires, &maxD, &maxA, &created, &devices, &accounts); e != nil {
			dbError(c, e)
			return
		}
		out = append(out, gin.H{"id": id, "label": label, "maskedCode": "GD7-••••-" + suffix, "enabled": enabled, "expiresAt": expires, "maxDevices": maxD, "maxAccounts": maxA, "deviceCount": devices, "accountCount": accounts, "createdAt": created})
	}
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	ok(c, out)
}
func (a *App) createCode(c *gin.Context) {
	var b codeInput
	if c.ShouldBindJSON(&b) != nil || !b.valid() {
		fail(c, 400, "请检查名称、有效期和额度（设备 1–100，账号 1–500）")
		return
	}
	id := identity(c)
	raw := "GD7-" + security.Token()
	var codeID string
	e := a.DB.QueryRow(c.Request.Context(), `INSERT INTO login_codes(tenant_id,label,code_hash,suffix,expires_at,max_devices,max_accounts) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`, id.Tenant, b.Label, security.Hash(raw), raw[len(raw)-6:], b.ExpiresAt, b.MaxDevices, b.MaxAccounts).Scan(&codeID)
	if e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code.create", true)
	ok(c, gin.H{"id": codeID, "code": raw})
}
func (a *App) updateCode(c *gin.Context) {
	var b codeInput
	if c.ShouldBindJSON(&b) != nil || len(b.Label) == 0 || len(b.Label) > 100 || b.MaxDevices < 1 || b.MaxDevices > 100 || b.MaxAccounts < 1 || b.MaxAccounts > 500 || b.ExpiresAt.IsZero() {
		fail(c, 400, "参数不正确")
		return
	}
	ctx := c.Request.Context()
	id := identity(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		dbError(c, e)
		return
	}
	defer tx.Rollback(ctx)
	var code string
	if e = tx.QueryRow(ctx, `SELECT id::text FROM login_codes WHERE id::text=$1 AND tenant_id=$2 FOR UPDATE`, c.Param("id"), id.Tenant).Scan(&code); errors.Is(e, pgx.ErrNoRows) {
		fail(c, 404, "登录码不存在")
		return
	} else if e != nil {
		dbError(c, e)
		return
	}
	var devices, accounts int
	e = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM devices WHERE code_id=$1 AND active),(SELECT count(*) FROM platform_accounts WHERE code_id=$1)`, code).Scan(&devices, &accounts)
	if e != nil {
		dbError(c, e)
		return
	}
	if b.MaxDevices < devices || b.MaxAccounts < accounts {
		fail(c, 409, "额度不能低于现有设备或账号数量，请先解绑")
		return
	}
	_, e = tx.Exec(ctx, `UPDATE login_codes SET label=$1,enabled=$2,expires_at=$3,max_devices=$4,max_accounts=$5 WHERE id=$6`, b.Label, b.Enabled, b.ExpiresAt, b.MaxDevices, b.MaxAccounts, code)
	if e == nil && !b.Enabled {
		_, e = tx.Exec(ctx, `DELETE FROM client_sessions WHERE device_id IN(SELECT id FROM devices WHERE code_id=$1)`, code)
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code.update", true)
	ok(c, true)
}
func (a *App) resetCode(c *gin.Context) {
	id := identity(c)
	ctx := c.Request.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		dbError(c, e)
		return
	}
	defer tx.Rollback(ctx)
	raw := "GD7-" + security.Token()
	var code string
	e = tx.QueryRow(ctx, `UPDATE login_codes SET code_hash=$1,suffix=$2 WHERE id::text=$3 AND tenant_id=$4 RETURNING id::text`, security.Hash(raw), raw[len(raw)-6:], c.Param("id"), id.Tenant).Scan(&code)
	if errors.Is(e, pgx.ErrNoRows) {
		fail(c, 404, "登录码不存在")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if _, e = tx.Exec(ctx, `DELETE FROM client_sessions WHERE device_id IN(SELECT id FROM devices WHERE code_id=$1)`, code); e != nil {
		dbError(c, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code.reset", true)
	ok(c, gin.H{"code": raw})
}
func (a *App) listDevices(c *gin.Context) {
	rows, e := a.DB.Query(c.Request.Context(), `SELECT d.id::text,d.name,l.label,d.active,d.last_seen FROM devices d JOIN login_codes l ON l.id=d.code_id WHERE d.tenant_id=$1 ORDER BY last_seen DESC`, identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, name, label string
		var active bool
		var seen time.Time
		if e = rows.Scan(&id, &name, &label, &active, &seen); e != nil {
			dbError(c, e)
			return
		}
		out = append(out, gin.H{"id": id, "name": name, "codeLabel": label, "active": active, "lastSeen": seen})
	}
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	ok(c, out)
}
func (a *App) revokeDevice(c *gin.Context) {
	ctx := c.Request.Context()
	id := identity(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		dbError(c, e)
		return
	}
	defer tx.Rollback(ctx)
	// Serialize with login and quota updates by locking the code first.
	var code string
	e = tx.QueryRow(ctx, `SELECT l.id::text FROM login_codes l JOIN devices d ON d.code_id=l.id WHERE d.id::text=$1 AND d.tenant_id=$2 FOR UPDATE OF l`, c.Param("id"), id.Tenant).Scan(&code)
	if errors.Is(e, pgx.ErrNoRows) {
		fail(c, 404, "设备不存在")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if _, e = tx.Exec(ctx, `UPDATE devices SET active=false WHERE id::text=$1 AND tenant_id=$2`, c.Param("id"), id.Tenant); e == nil {
		_, e = tx.Exec(ctx, `DELETE FROM client_sessions WHERE device_id::text=$1`, c.Param("id"))
	}
	if e == nil {
		_, e = tx.Exec(ctx, `UPDATE platform_accounts SET device_id=NULL,observed_status='not_opened',observed_at=NULL WHERE device_id::text=$1`, c.Param("id"))
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "device.unbind", true)
	ok(c, true)
}
