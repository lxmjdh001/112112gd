package app

import (
	"github.com/gin-gonic/gin"
	"gongdan007/server/internal/proxy"
	"gongdan007/server/internal/security"
	"strings"
	"time"
)

func (a *App) listProxies(c *gin.Context) {
	rows, e := a.DB.Query(c.Request.Context(), `SELECT p.id::text,p.label,p.protocol,p.host,p.port,p.username,COALESCE(g.name,''),p.enabled,p.created_at,COALESCE(p.group_id::text,''),p.max_accounts_per_platform,COALESCE((SELECT jsonb_object_agg(platform,used) FROM (SELECT platform,count(*) AS used FROM platform_accounts WHERE proxy_id=p.id GROUP BY platform) usage),'{}'::jsonb) FROM proxies p LEFT JOIN proxy_groups g ON g.id=p.group_id AND g.tenant_id=p.tenant_id WHERE p.tenant_id=$1 ORDER BY p.created_at DESC`, identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, label, protocol, host, user, group, groupID string
		var port, max int
		var usage map[string]int
		var enabled bool
		var at time.Time
		if e = rows.Scan(&id, &label, &protocol, &host, &port, &user, &group, &enabled, &at, &groupID, &max, &usage); e != nil {
			dbError(c, e)
			return
		}
		out = append(out, gin.H{"id": id, "label": label, "protocol": protocol, "host": host, "port": port, "username": user, "group": group, "enabled": enabled, "createdAt": at, "groupId": groupID, "maxAccountsPerPlatform": max, "platformUsage": usage})
	}
	if e = rows.Err(); e != nil {
		dbError(c, e)
		return
	}
	ok(c, out)
}
func (a *App) importProxies(c *gin.Context) {
	var b struct {
		Lines                  string  `json:"lines"`
		Protocol               string  `json:"protocol"`
		Group                  string  `json:"group"`
		GroupID                *string `json:"groupId"`
		MaxAccountsPerPlatform *int    `json:"maxAccountsPerPlatform"`
		Enabled                *bool   `json:"enabled"`
	}
	if c.ShouldBindJSON(&b) != nil || len(b.Lines) > 150000 || len(b.Group) > 100 {
		fail(c, 400, "导入内容过长")
		return
	}
	max, enabled := 1, true
	if b.MaxAccountsPerPlatform != nil {
		max = *b.MaxAccountsPerPlatform
	}
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	if max < 1 || max > 10000 {
		fail(c, 400, "每平台账号额度须为 1–10000")
		return
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
	groupID := ""
	if b.GroupID != nil {
		groupID = *b.GroupID
	} else if legacyName := strings.TrimSpace(b.Group); legacyName != "" {
		if e = tx.QueryRow(ctx, `INSERT INTO proxy_groups(tenant_id,name) VALUES($1,$2) ON CONFLICT(tenant_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id::text`, id.Tenant, legacyName).Scan(&groupID); e != nil {
			dbError(c, e)
			return
		}
	}
	if !lockProxyGroup(c, tx, id.Tenant, groupID) {
		return
	}
	for _, p := range parsed {
		encrypted, e := security.Seal(a.Key, p.Password)
		if e != nil {
			dbError(c, e)
			return
		}
		if _, e = tx.Exec(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher,group_id,max_accounts_per_platform,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::uuid,$9,$10)`, id.Tenant, p.Host, p.Protocol, p.Host, p.Port, p.Username, encrypted, groupID, max, enabled); e != nil {
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
