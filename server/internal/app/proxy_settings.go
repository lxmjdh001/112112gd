package app

import "github.com/gin-gonic/gin"

func (a *App) updateProxies(c *gin.Context) {
	var body struct {
		IDs                    []string `json:"ids"`
		GroupID                *string  `json:"groupId"`
		Enabled                *bool    `json:"enabled"`
		MaxAccountsPerPlatform *int     `json:"maxAccountsPerPlatform"`
	}
	if c.ShouldBindJSON(&body) != nil {
		fail(c, 400, "设置参数无效")
		return
	}
	if key := c.Param("id"); key != "" {
		body.IDs = []string{key}
	}
	if len(body.IDs) < 1 || len(body.IDs) > 500 || (body.GroupID == nil && body.Enabled == nil && body.MaxAccountsPerPlatform == nil) {
		fail(c, 400, "请选择 1–500 个代理及需要修改的设置")
		return
	}
	if body.MaxAccountsPerPlatform != nil && (*body.MaxAccountsPerPlatform < 1 || *body.MaxAccountsPerPlatform > 10000) {
		fail(c, 400, "每平台账号额度须为 1–10000")
		return
	}
	seen := map[string]bool{}
	for _, key := range body.IDs {
		if key == "" || seen[key] {
			fail(c, 400, "代理列表无效，请重新选择")
			return
		}
		seen[key] = true
	}
	id := identity(c)
	ctx := c.Request.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		dbError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	groupID := ""
	if body.GroupID != nil {
		groupID = *body.GroupID
		if !lockProxyGroup(c, tx, id.Tenant, groupID) {
			return
		}
	}
	hostRows, err := tx.Query(ctx, `SELECT DISTINCT host FROM proxies WHERE tenant_id=$1 AND id::text=ANY($2::text[])`, id.Tenant, body.IDs)
	if err != nil {
		dbError(c, err)
		return
	}
	hosts := []string{}
	for hostRows.Next() {
		var host string
		if err = hostRows.Scan(&host); err != nil {
			hostRows.Close()
			dbError(c, err)
			return
		}
		hosts = append(hosts, host)
	}
	err = hostRows.Err()
	hostRows.Close()
	if err == nil {
		err = lockProxyHosts(ctx, tx, id.Tenant, hosts)
	}
	if err != nil {
		dbError(c, err)
		return
	}
	rows, err := tx.Query(ctx, `SELECT id FROM proxies WHERE tenant_id=$1 AND id::text=ANY($2::text[]) ORDER BY id FOR UPDATE`, id.Tenant, body.IDs)
	if err != nil {
		dbError(c, err)
		return
	}
	count := 0
	for rows.Next() {
		count++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		dbError(c, err)
		return
	}
	if count != len(body.IDs) {
		fail(c, 404, "部分代理不存在，请刷新后重试")
		return
	}
	if body.MaxAccountsPerPlatform != nil {
		var largest int
		err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(used),0) FROM (SELECT p.host,a.platform,count(*) AS used FROM platform_accounts a JOIN proxies p ON p.id=a.proxy_id WHERE p.tenant_id=$1 AND p.host=ANY($2::text[]) GROUP BY p.host,a.platform) usage`, id.Tenant, hosts).Scan(&largest)
		if err != nil {
			dbError(c, err)
			return
		}
		if largest > *body.MaxAccountsPerPlatform {
			fail(c, 409, "每平台最多登录数不能低于该 IP 已占用的同平台账号数量")
			return
		}
	}
	if body.MaxAccountsPerPlatform != nil {
		_, err = tx.Exec(ctx, `UPDATE proxies SET max_accounts_per_platform=$1 WHERE tenant_id=$2 AND host=ANY($3::text[])`, *body.MaxAccountsPerPlatform, id.Tenant, hosts)
		if err != nil {
			dbError(c, err)
			return
		}
	}
	_, err = tx.Exec(ctx, `UPDATE proxies SET enabled=COALESCE($1,enabled),max_accounts_per_platform=COALESCE($2,max_accounts_per_platform),group_id=CASE WHEN $3 THEN NULLIF($4,'')::uuid ELSE group_id END WHERE tenant_id=$5 AND id::text=ANY($6::text[])`, body.Enabled, body.MaxAccountsPerPlatform, body.GroupID != nil, groupID, id.Tenant, body.IDs)
	if err != nil {
		dbError(c, err)
		return
	}
	if body.Enabled != nil && !*body.Enabled {
		if _, err = tx.Exec(ctx, `UPDATE platform_accounts SET observed_status='closed',observed_at=now() WHERE tenant_id=$1 AND proxy_id::text=ANY($2::text[])`, id.Tenant, body.IDs); err != nil {
			dbError(c, err)
			return
		}
	}
	if err = tx.Commit(ctx); err != nil {
		dbError(c, err)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "proxy.update", true)
	ok(c, gin.H{"count": count})
}
