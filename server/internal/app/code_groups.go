package app

import (
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (a *App) listCodeGroups(c *gin.Context) {
	rows, err := a.DB.Query(c.Request.Context(), `SELECT g.id::text,g.name,count(l.id) FROM login_code_groups g LEFT JOIN login_codes l ON l.group_id=g.id AND l.tenant_id=g.tenant_id AND l.deleted_at IS NULL WHERE g.tenant_id=$1 GROUP BY g.id ORDER BY g.name,g.id`, identity(c).Tenant)
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
		out = append(out, gin.H{"id": id, "name": name, "codeCount": count})
	}
	if err = rows.Err(); err != nil {
		dbError(c, err)
		return
	}
	ok(c, out)
}

func groupName(c *gin.Context) (string, bool) {
	var body struct {
		Name string `json:"name"`
	}
	if c.ShouldBindJSON(&body) != nil {
		fail(c, 400, "请填写分组名称")
		return "", false
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || utf8.RuneCountInString(name) > 50 || name == "未分组" || name == "全部分组" {
		fail(c, 400, "分组名称须为 1–50 个字符，不能使用“未分组”或“全部分组”")
		return "", false
	}
	return name, true
}

func groupError(c *gin.Context, err error) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		fail(c, 409, "已存在同名分组，请使用其他名称")
		return
	}
	dbError(c, err)
}

func (a *App) createCodeGroup(c *gin.Context) {
	name, valid := groupName(c)
	if !valid {
		return
	}
	id := identity(c)
	var groupID string
	err := a.DB.QueryRow(c.Request.Context(), `INSERT INTO login_code_groups(tenant_id,name) VALUES($1,$2) RETURNING id::text`, id.Tenant, name).Scan(&groupID)
	if err != nil {
		groupError(c, err)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code_group.create", true)
	ok(c, gin.H{"id": groupID, "name": name, "codeCount": 0})
}

func (a *App) renameCodeGroup(c *gin.Context) {
	name, valid := groupName(c)
	if !valid {
		return
	}
	id := identity(c)
	result, err := a.DB.Exec(c.Request.Context(), `UPDATE login_code_groups SET name=$1 WHERE id::text=$2 AND tenant_id=$3`, name, c.Param("id"), id.Tenant)
	if err != nil {
		groupError(c, err)
		return
	}
	if result.RowsAffected() == 0 {
		fail(c, 404, "分组不存在，请刷新后重试")
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code_group.rename", true)
	ok(c, true)
}

func (a *App) deleteCodeGroup(c *gin.Context) {
	id := identity(c)
	// The tenant-aware FK moves members to ungrouped in the same transaction.
	result, err := a.DB.Exec(c.Request.Context(), `DELETE FROM login_code_groups WHERE id::text=$1 AND tenant_id=$2`, c.Param("id"), id.Tenant)
	if err != nil {
		dbError(c, err)
		return
	}
	if result.RowsAffected() == 0 {
		fail(c, 404, "分组不存在，请刷新后重试")
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code_group.delete", true)
	ok(c, true)
}

// Take the group lock before code locks, so deletion cannot race an assignment.
func lockCodeGroup(c *gin.Context, tx pgx.Tx, tenant, groupID string) bool {
	if groupID == "" {
		return true
	}
	var found string
	err := tx.QueryRow(c.Request.Context(), `SELECT id::text FROM login_code_groups WHERE id::text=$1 AND tenant_id=$2 FOR KEY SHARE`, groupID, tenant).Scan(&found)
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

func (a *App) moveCodesGroup(c *gin.Context) {
	var body struct {
		IDs     []string `json:"ids"`
		GroupID *string  `json:"groupId"`
	}
	if c.ShouldBindJSON(&body) != nil || len(body.IDs) == 0 || len(body.IDs) > 500 || body.GroupID == nil {
		fail(c, 400, "请选择 1–500 个登录码及目标分组")
		return
	}
	seen := map[string]bool{}
	for _, id := range body.IDs {
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
	if !lockCodeGroup(c, tx, id.Tenant, *body.GroupID) {
		return
	}
	rows, err := tx.Query(ctx, `SELECT id::text FROM login_codes WHERE tenant_id=$1 AND deleted_at IS NULL AND id::text=ANY($2::text[]) ORDER BY id FOR UPDATE`, id.Tenant, body.IDs)
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
		fail(c, 404, "部分登录码不存在，请刷新后重新选择")
		return
	}
	_, err = tx.Exec(ctx, `UPDATE login_codes SET group_id=NULLIF($1,'')::uuid WHERE tenant_id=$2 AND id::text=ANY($3::text[])`, *body.GroupID, id.Tenant, body.IDs)
	if err != nil {
		dbError(c, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		dbError(c, err)
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code.move_group", true)
	ok(c, gin.H{"count": count})
}
