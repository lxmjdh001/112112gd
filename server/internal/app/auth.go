package app

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
	"gongdan007/server/internal/security"
	"time"
)

func (a *App) adminLogin(c *gin.Context) {
	var b struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if c.ShouldBindJSON(&b) != nil || len(b.Password) > 72 {
		fail(c, 400, "请填写账号和密码")
		return
	}
	var id, tenant, hash string
	e := a.DB.QueryRow(c.Request.Context(), `SELECT id::text,tenant_id::text,password_hash FROM admins WHERE username=$1`, b.Username).Scan(&id, &tenant, &hash)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		dbError(c, e)
		return
	}
	if e != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(b.Password)) != nil {
		a.audit(c, tenant, truncate(b.Username, 100), "admin.login", false)
		fail(c, 401, "账号或密码错误")
		return
	}
	token := security.Token()
	if _, e = a.DB.Exec(c.Request.Context(), `INSERT INTO admin_sessions VALUES($1,$2,now()+interval '8 hours')`, security.Hash(token), id); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, tenant, id, "admin.login", true)
	ok(c, gin.H{"accessToken": token})
}
func (a *App) userInfo(c *gin.Context) {
	id := identity(c)
	var name string
	if e := a.DB.QueryRow(c.Request.Context(), `SELECT username FROM admins WHERE id=$1`, id.Actor).Scan(&name); e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"userId": id.Actor, "username": name, "realName": name, "roles": []string{"admin"}, "homePath": "/dashboard", "tenantId": id.Tenant, "avatar": "/logo.svg"})
}
func (a *App) adminLogout(c *gin.Context) {
	_, e := a.DB.Exec(c.Request.Context(), `DELETE FROM admin_sessions WHERE token_hash=$1`, security.Hash(c.GetHeader("Authorization")[7:]))
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, true)
}
func (a *App) clientLogin(c *gin.Context) {
	var b struct {
		Code       string `json:"code"`
		DeviceID   string `json:"deviceId"`
		DeviceName string `json:"deviceName"`
	}
	if c.ShouldBindJSON(&b) != nil || len(b.Code) > 100 || len(b.DeviceID) < 32 || len(b.DeviceID) > 128 || len(b.DeviceName) > 100 {
		fail(c, 400, "登录参数不完整")
		return
	}
	ctx := c.Request.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		dbError(c, e)
		return
	}
	defer tx.Rollback(ctx)
	var code, tenant, label string
	var max int
	var enabled bool
	var expires time.Time
	e = tx.QueryRow(ctx, `SELECT id::text,tenant_id::text,label,max_devices,enabled,expires_at FROM login_codes WHERE code_hash=$1 FOR UPDATE`, security.Hash(b.Code)).Scan(&code, &tenant, &label, &max, &enabled, &expires)
	if errors.Is(e, pgx.ErrNoRows) {
		a.audit(c, "", "unknown", "client.login", false)
		fail(c, 401, "登录码无效")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if !enabled || !expires.After(time.Now()) {
		a.audit(c, tenant, code, "client.login", false)
		fail(c, 401, "登录码已停用或到期")
		return
	}
	var device string
	var active bool
	e = tx.QueryRow(ctx, `SELECT id::text,active FROM devices WHERE code_id=$1 AND identity_hash=$2`, code, security.Hash(b.DeviceID)).Scan(&device, &active)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		dbError(c, e)
		return
	}
	if device == "" || !active {
		var n int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM devices WHERE code_id=$1 AND active`, code).Scan(&n); e != nil {
			dbError(c, e)
			return
		}
		if n >= max {
			fail(c, 409, "设备数量已达上限，请联系管理员解绑设备")
			return
		}
	}
	e = tx.QueryRow(ctx, `INSERT INTO devices(tenant_id,code_id,identity_hash,name) VALUES($1,$2,$3,$4) ON CONFLICT(code_id,identity_hash) DO UPDATE SET active=true,last_seen=now(),name=EXCLUDED.name RETURNING id::text`, tenant, code, security.Hash(b.DeviceID), b.DeviceName).Scan(&device)
	if e != nil {
		dbError(c, e)
		return
	}
	token := security.Token()
	if _, e = tx.Exec(ctx, `DELETE FROM client_sessions WHERE device_id=$1`, device); e == nil {
		_, e = tx.Exec(ctx, `INSERT INTO client_sessions VALUES($1,$2,now()+interval '7 days')`, security.Hash(token), device)
	}
	if e != nil {
		dbError(c, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, tenant, device, "client.login", true)
	ok(c, gin.H{"accessToken": token, "deviceId": device, "tenantId": tenant, "codeId": code, "label": label, "leaseSeconds": 150})
}
func (a *App) heartbeat(c *gin.Context) {
	id := identity(c)
	if _, e := a.DB.Exec(c.Request.Context(), `UPDATE devices SET last_seen=now() WHERE id=$1`, id.Device); e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"leaseSeconds": 150})
}
func (a *App) clientLogout(c *gin.Context) {
	id := identity(c)
	if _, e := a.DB.Exec(c.Request.Context(), `DELETE FROM client_sessions WHERE token_hash=$1`, security.Hash(c.GetHeader("Authorization")[7:])); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, id.Tenant, id.Device, "client.logout", true)
	ok(c, true)
}
