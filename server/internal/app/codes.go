package app

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
	"time"
)

type codeInput struct {
	AllowedPlatforms *[]string `json:"allowedPlatforms"`
	Label            string    `json:"label"`
	GroupID          string    `json:"groupId"`
	ExpiresAt        time.Time `json:"expiresAt"`
	Enabled          bool      `json:"enabled"`
}

func (b codeInput) valid() bool {
	return len(b.Label) > 0 && len(b.Label) <= 100 && b.ExpiresAt.After(time.Now())
}
func (a *App) listCodes(c *gin.Context) {
	rows, e := a.DB.Query(c.Request.Context(), `SELECT l.id::text,l.label,l.suffix,l.enabled,l.expires_at,l.created_at,(SELECT count(*) FROM devices d WHERE d.code_id=l.id AND d.active),(SELECT count(*) FROM platform_accounts p WHERE p.code_id=l.id),COALESCE(l.group_id::text,''),COALESCE(g.name,''),l.allowed_platforms,l.code_cipher<>'' FROM login_codes l LEFT JOIN login_code_groups g ON g.id=l.group_id AND g.tenant_id=l.tenant_id WHERE l.tenant_id=$1 AND l.deleted_at IS NULL ORDER BY l.created_at DESC`, identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, label, suffix, groupID, groupName string
		var enabled, canCopy bool
		var platforms []string
		var expires, created time.Time
		var devices, accounts int
		if e = rows.Scan(&id, &label, &suffix, &enabled, &expires, &created, &devices, &accounts, &groupID, &groupName, &platforms, &canCopy); e != nil {
			dbError(c, e)
			return
		}
		out = append(out, gin.H{"id": id, "label": label, "maskedCode": "GD7-••••-" + suffix, "enabled": enabled, "expiresAt": expires, "deviceCount": devices, "accountCount": accounts, "createdAt": created, "groupId": groupID, "groupName": groupName, "allowedPlatforms": platforms, "canCopy": canCopy})
	}
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	ok(c, out)
}
func (a *App) createCode(c *gin.Context) {
	var b codeInput
	if c.ShouldBindJSON(&b) != nil || !b.valid() || b.AllowedPlatforms == nil || len(*b.AllowedPlatforms) == 0 || !validPlatformGrants(*b.AllowedPlatforms) {
		fail(c, 400, "请检查名称和有效期，并至少勾选一个已开放的平台")
		return
	}
	id := identity(c)
	ctx := c.Request.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		dbError(c, e)
		return
	}
	defer tx.Rollback(ctx)
	if !lockCodeGroup(c, tx, id.Tenant, b.GroupID) {
		return
	}
	raw := "GD7-" + security.Token()
	encrypted, e := security.Seal(a.Key, raw)
	if e != nil {
		dbError(c, e)
		return
	}
	var codeID string
	e = tx.QueryRow(ctx, `INSERT INTO login_codes(tenant_id,label,code_hash,suffix,expires_at,group_id,allowed_platforms,code_cipher) VALUES($1,$2,$3,$4,$5,NULLIF($6,'')::uuid,$7,$8) RETURNING id::text`, id.Tenant, b.Label, security.Hash(raw), raw[len(raw)-6:], b.ExpiresAt, b.GroupID, *b.AllowedPlatforms, encrypted).Scan(&codeID)
	if e != nil {
		dbError(c, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code.create", true)
	ok(c, gin.H{"id": codeID, "code": raw})
}
func (a *App) updateCode(c *gin.Context) {
	var b codeInput
	if c.ShouldBindJSON(&b) != nil || len(b.Label) == 0 || len(b.Label) > 100 || b.ExpiresAt.IsZero() || (b.AllowedPlatforms != nil && !validPlatformGrants(*b.AllowedPlatforms)) {
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
	if e = tx.QueryRow(ctx, `SELECT id::text FROM login_codes WHERE id::text=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, c.Param("id"), id.Tenant).Scan(&code); errors.Is(e, pgx.ErrNoRows) {
		fail(c, 404, "登录码不存在")
		return
	} else if e != nil {
		dbError(c, e)
		return
	}
	var platforms any
	if b.AllowedPlatforms != nil {
		platforms = *b.AllowedPlatforms
	}
	_, e = tx.Exec(ctx, `UPDATE login_codes SET label=$1,enabled=$2,expires_at=$3,allowed_platforms=COALESCE($5,allowed_platforms) WHERE id=$4`, b.Label, b.Enabled, b.ExpiresAt, code, platforms)
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
	encrypted, e := security.Seal(a.Key, raw)
	if e != nil {
		dbError(c, e)
		return
	}
	var code string
	e = tx.QueryRow(ctx, `UPDATE login_codes SET code_hash=$1,suffix=$2,code_cipher=$5 WHERE id::text=$3 AND tenant_id=$4 AND deleted_at IS NULL RETURNING id::text`, security.Hash(raw), raw[len(raw)-6:], c.Param("id"), id.Tenant, encrypted).Scan(&code)
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
	rows, e := a.DB.Query(c.Request.Context(), `SELECT d.id::text,d.name,l.label,d.active,d.last_seen FROM devices d JOIN login_codes l ON l.id=d.code_id WHERE d.tenant_id=$1 AND l.deleted_at IS NULL ORDER BY last_seen DESC`, identity(c).Tenant)
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
	// Serialize with login and authorization updates by locking the code first.
	var code string
	e = tx.QueryRow(ctx, `SELECT l.id::text FROM login_codes l JOIN devices d ON d.code_id=l.id WHERE d.id::text=$1 AND d.tenant_id=$2 AND l.deleted_at IS NULL FOR UPDATE OF l`, c.Param("id"), id.Tenant).Scan(&code)
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
