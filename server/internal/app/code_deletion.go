package app

import "github.com/gin-gonic/gin"

func (a *App) deleteCode(c *gin.Context) {
	a.deleteCodes(c, []string{c.Param("id")})
}

func (a *App) batchDeleteCodes(c *gin.Context) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if c.ShouldBindJSON(&body) != nil {
		fail(c, 400, "请选择要删除的登录码")
		return
	}
	a.deleteCodes(c, body.IDs)
}

func (a *App) deleteCodes(c *gin.Context, ids []string) {
	if len(ids) == 0 || len(ids) > 500 {
		fail(c, 400, "每次请选择 1–500 个登录码")
		return
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if id == "" || seen[id] {
			fail(c, 400, "登录码列表无效，请重新选择")
			return
		}
		seen[id] = true
	}
	id := identity(c)
	ctx := c.Request.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		dbError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	// Match the lock order used by login, reset, account creation and group moves.
	// Include already deleted rows so a retry after a lost response is idempotent.
	rows, err := tx.Query(ctx, `SELECT id::text FROM login_codes WHERE tenant_id=$1 AND id::text=ANY($2::text[]) ORDER BY id FOR UPDATE`, id.Tenant, ids)
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
	if count != len(ids) {
		fail(c, 404, "部分登录码不存在，请刷新后重新选择")
		return
	}
	_, err = tx.Exec(ctx, `UPDATE login_codes SET deleted_at=COALESCE(deleted_at,now()),enabled=false,code_cipher='' WHERE tenant_id=$1 AND id::text=ANY($2::text[])`, id.Tenant, ids)
	if err == nil {
		_, err = tx.Exec(ctx, `DELETE FROM client_sessions WHERE device_id IN (SELECT id FROM devices WHERE tenant_id=$1 AND code_id::text=ANY($2::text[]))`, id.Tenant, ids)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE devices SET active=false WHERE tenant_id=$1 AND code_id::text=ANY($2::text[])`, id.Tenant, ids)
	}
	if err != nil {
		dbError(c, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		dbError(c, err)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code.delete", true)
	ok(c, gin.H{"count": count})
}
