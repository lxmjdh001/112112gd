package app

import (
	"github.com/gin-gonic/gin"
	"time"
)

func (a *App) dashboard(c *gin.Context) {
	var codes, devices, accounts, proxies int
	e := a.DB.QueryRow(c.Request.Context(), `SELECT (SELECT count(*) FROM login_codes WHERE tenant_id=$1 AND enabled AND deleted_at IS NULL AND expires_at>now()),(SELECT count(*) FROM devices WHERE tenant_id=$1 AND active AND last_seen>now()-interval '90 seconds'),(SELECT count(*) FROM platform_accounts WHERE tenant_id=$1 AND removed_at IS NULL),(SELECT count(*) FROM proxies WHERE tenant_id=$1 AND enabled)`, identity(c).Tenant).Scan(&codes, &devices, &accounts, &proxies)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"codes": codes, "devices": devices, "accounts": accounts, "proxies": proxies})
}
func (a *App) logs(c *gin.Context) {
	rows, e := a.DB.Query(c.Request.Context(), `SELECT id,actor,action,success,ip,device,created_at FROM audit_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200`, identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id int
		var actor, action, ip, device string
		var success bool
		var at time.Time
		if e = rows.Scan(&id, &actor, &action, &success, &ip, &device, &at); e != nil {
			dbError(c, e)
			return
		}
		out = append(out, gin.H{"id": id, "actor": actor, "action": action, "success": success, "ip": ip, "device": device, "createdAt": at})
	}
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	ok(c, out)
}
