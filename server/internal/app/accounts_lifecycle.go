package app

import (
	"errors"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
)

func (a *App) closeClientAccount(c *gin.Context)        { a.changeClientAccount(c, "close") }
func (a *App) removeClientAccount(c *gin.Context)       { a.changeClientAccount(c, "remove") }
func (a *App) restoreClientCloudAccount(c *gin.Context) { a.changeClientAccount(c, "restore") }

// Native removal keeps a tombstone for customer history. Cloud preferences belong
// to this device only; removing an API number never deletes the shared number.
func (a *App) changeClientAccount(c *gin.Context, action string) {
	id := identity(c)
	ctx := c.Request.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		dbError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	var code string
	err = tx.QueryRow(ctx, `SELECT id::text FROM login_codes WHERE id=$1 AND tenant_id=$2 AND enabled AND deleted_at IS NULL AND expires_at>now() FOR UPDATE`, id.Code, id.Tenant).Scan(&code)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 401, "登录权限已失效")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	var authorized bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM client_sessions s JOIN devices d ON d.id=s.device_id WHERE s.token_hash=$1 AND s.expires_at>now() AND d.id=$2 AND d.code_id=$3 AND d.tenant_id=$4 AND d.active)`, security.Hash(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")), id.Device, id.Code, id.Tenant).Scan(&authorized)
	if err != nil {
		dbError(c, err)
		return
	}
	if !authorized {
		fail(c, 401, "当前设备授权已失效")
		return
	}
	var kind string
	var paused, removed bool
	err = tx.QueryRow(ctx, `SELECT a.connection_type,a.paused_at IS NOT NULL,a.removed_at IS NOT NULL FROM platform_accounts a WHERE a.id::text=$1 AND a.tenant_id=$2 AND ((a.connection_type='web' AND a.code_id=$3 AND a.device_id=$4) OR (a.connection_type='cloud' AND EXISTS(SELECT 1 FROM wa_cloud_assignments x WHERE x.number_id=a.id AND x.tenant_id=$2 AND x.code_id=$3))) FOR UPDATE OF a`, c.Param("id"), id.Tenant, id.Code, id.Device).Scan(&kind, &paused, &removed)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 404, "账号不属于当前客户端")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	if kind == "web" {
		if action == "restore" {
			fail(c, 400, "扫码账号请点击账号重新打开")
			return
		}
		if removed && action != "remove" {
			fail(c, 404, "号位已移除")
			return
		}
		if action == "remove" && !paused && !removed {
			fail(c, 409, "请先退登账号，再确认移除号位")
			return
		}
		if action == "close" {
			_, err = tx.Exec(ctx, `UPDATE platform_accounts SET paused_at=now(),observed_status='closed',observed_at=now() WHERE id::text=$1`, c.Param("id"))
		} else {
			_, err = tx.Exec(ctx, `UPDATE platform_accounts SET removed_at=COALESCE(removed_at,now()),observed_status='closed',observed_at=now() WHERE id::text=$1`, c.Param("id"))
		}
	} else {
		var hidden bool
		err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT paused FROM client_account_preferences WHERE device_id=$1 AND account_id::text=$2),false),COALESCE((SELECT hidden FROM client_account_preferences WHERE device_id=$1 AND account_id::text=$2),false)`, id.Device, c.Param("id")).Scan(&paused, &hidden)
		if err != nil {
			dbError(c, err)
			return
		}
		if hidden && action == "close" {
			fail(c, 404, "号码已从当前客户端移除")
			return
		}
		if action == "remove" && !paused {
			fail(c, 409, "请先关闭聊天，再确认从客户端移除")
			return
		}
		if action == "restore" {
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM wa_cloud_numbers n JOIN login_codes l ON l.id=$2 WHERE n.id::text=$1 AND n.enabled AND 'whatsapp_cloud'=ANY(l.allowed_platforms))`, c.Param("id"), id.Code).Scan(&authorized)
			if err != nil {
				dbError(c, err)
				return
			}
			if !authorized {
				fail(c, 403, "API 号码或平台授权不可用")
				return
			}
		}
		_, err = tx.Exec(ctx, `INSERT INTO client_account_preferences(tenant_id,device_id,account_id,paused,hidden) VALUES($1,$2,$3,$4,$5) ON CONFLICT(device_id,account_id) DO UPDATE SET paused=EXCLUDED.paused,hidden=EXCLUDED.hidden`, id.Tenant, id.Device, c.Param("id"), action != "restore", action == "remove")
	}
	if err != nil {
		dbError(c, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		dbError(c, err)
		return
	}
	a.audit(c, id.Tenant, id.Device, "client.account."+action, true)
	ok(c, true)
}
