package app

import (
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

func (a *App) listProxyGroups(c *gin.Context) {
	rows, err := a.DB.Query(c.Request.Context(), `SELECT g.id::text,g.name,count(l.id) FROM proxy_groups g LEFT JOIN proxies l ON l.group_id=g.id AND l.tenant_id=g.tenant_id WHERE g.tenant_id=$1 GROUP BY g.id ORDER BY g.name,g.id`, identity(c).Tenant)
	if err != nil {
		dbError(c, err)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, name string
		var count int64
		if err = rows.Scan(&id, &name, &count); err != nil {
			dbError(c, err)
			return
		}
		out = append(out, gin.H{"id": id, "name": name, "proxyCount": count})
	}
	if err = rows.Err(); err != nil {
		dbError(c, err)
		return
	}
	ok(c, out)
}

func (a *App) createProxyGroup(c *gin.Context) {
	name, valid := groupName(c)
	if !valid {
		return
	}
	id := identity(c)
	var groupID string
	err := a.DB.QueryRow(c.Request.Context(), `INSERT INTO proxy_groups(tenant_id,name) VALUES($1,$2) RETURNING id::text`, id.Tenant, name).Scan(&groupID)
	if err != nil {
		groupError(c, err)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "proxy_group.create", true)
	ok(c, gin.H{"id": groupID, "name": name, "proxyCount": 0})
}

func (a *App) renameProxyGroup(c *gin.Context) {
	name, valid := groupName(c)
	if !valid {
		return
	}
	id := identity(c)
	result, err := a.DB.Exec(c.Request.Context(), `UPDATE proxy_groups SET name=$1 WHERE id::text=$2 AND tenant_id=$3`, name, c.Param("id"), id.Tenant)
	if err != nil {
		groupError(c, err)
		return
	}
	if result.RowsAffected() == 0 {
		fail(c, 404, "分组不存在，请刷新后重试")
		return
	}
	a.audit(c, id.Tenant, id.Actor, "proxy_group.rename", true)
	ok(c, true)
}

func (a *App) deleteProxyGroup(c *gin.Context) {
	id := identity(c)
	// The tenant-aware FK moves members to ungrouped in the same transaction.
	result, err := a.DB.Exec(c.Request.Context(), `DELETE FROM proxy_groups WHERE id::text=$1 AND tenant_id=$2`, c.Param("id"), id.Tenant)
	if err != nil {
		dbError(c, err)
		return
	}
	if result.RowsAffected() == 0 {
		fail(c, 404, "分组不存在，请刷新后重试")
		return
	}
	a.audit(c, id.Tenant, id.Actor, "proxy_group.delete", true)
	ok(c, true)
}

// Take the group lock before proxy locks, so deletion cannot race an assignment.
func lockProxyGroup(c *gin.Context, tx pgx.Tx, tenant, groupID string) bool {
	if groupID == "" {
		return true
	}
	var found string
	err := tx.QueryRow(c.Request.Context(), `SELECT id::text FROM proxy_groups WHERE id::text=$1 AND tenant_id=$2 FOR KEY SHARE`, groupID, tenant).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 404, "分组不存在，请刷新后重试")
		return false
	}
	if err != nil {
		dbError(c, err)
		return false
	}
	return true
}
