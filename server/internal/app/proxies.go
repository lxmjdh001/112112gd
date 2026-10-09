package app

import (
	"github.com/gin-gonic/gin"
	"gongdan007/server/internal/proxy"
	"gongdan007/server/internal/security"
	"strings"
	"time"
)

func (a *App) listProxies(c *gin.Context) {
	rows, e := a.DB.Query(c.Request.Context(), `SELECT id::text,label,protocol,host,port,username,group_name,enabled,created_at FROM proxies WHERE tenant_id=$1 ORDER BY created_at DESC`, identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, label, protocol, host, user, group string
		var port int
		var enabled bool
		var at time.Time
		if e = rows.Scan(&id, &label, &protocol, &host, &port, &user, &group, &enabled, &at); e != nil {
			dbError(c, e)
			return
		}
		out = append(out, gin.H{"id": id, "label": label, "protocol": protocol, "host": host, "port": port, "username": user, "group": group, "enabled": enabled, "createdAt": at})
	}
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	ok(c, out)
}
func (a *App) importProxies(c *gin.Context) {
	var b struct {
		Lines    string `json:"lines"`
		Protocol string `json:"protocol"`
		Group    string `json:"group"`
	}
	if c.ShouldBindJSON(&b) != nil || len(b.Lines) > 150000 || len(b.Group) > 100 {
		fail(c, 400, "导入内容过长")
		return
	}
	if b.Group == "" {
		b.Group = "默认分组"
	}
	lines := strings.Split(strings.TrimSpace(b.Lines), "\n")
	if len(lines) > 100 {
		fail(c, 400, "每次最多导入 100 行")
		return
	}
	parsed := []proxy.Config{}
	bad := []gin.H{}
	seen := map[proxy.Config]bool{}
	duplicates := 0
	for n, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		p, e := proxy.Parse(line, b.Protocol)
		if e != nil {
			bad = append(bad, gin.H{"line": n + 1, "message": e.Error()})
			continue
		}
		if seen[p] {
			duplicates++
			continue
		}
		seen[p] = true
		parsed = append(parsed, p)
	}
	if len(bad) > 0 {
		c.JSON(400, gin.H{"code": 400, "message": "存在格式错误，本次未导入", "errors": bad})
		return
	}
	if len(parsed) == 0 {
		fail(c, 400, "请填写代理，每行一个")
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
	for _, p := range parsed {
		encrypted, e := security.Seal(a.Key, p.Password)
		if e != nil {
			dbError(c, e)
			return
		}
		if _, e = tx.Exec(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher,group_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id.Tenant, p.Host, p.Protocol, p.Host, p.Port, p.Username, encrypted, b.Group); e != nil {
			dbError(c, e)
			return
		}
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "proxy.import", true)
	ok(c, gin.H{"imported": len(parsed), "duplicates": duplicates})
}
