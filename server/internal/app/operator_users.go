package app

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
	"regexp"
	"strings"
)

var operatorUserID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (a *App) listOperatorUsers(c *gin.Context) {
	search := strings.TrimSpace(c.Query("search"))
	if len([]rune(search)) > 100 {
		fail(c, 400, "搜索内容最多 100 字")
		return
	}
	status, role := c.Query("status"), c.Query("role")
	if (status != "" && status != "enabled" && status != "disabled") || (role != "" && role != "customer" && role != "operator") {
		fail(c, 400, "筛选条件无效")
		return
	}
	a.commerceList(c, `a.id::text AS "id",a.username,a.display_name AS "displayName",a.contact,t.name AS "teamName",a.tenant_id::text AS "tenantId",a.platform_operator AS "isOperator",(a.disabled_at IS NOT NULL) AS disabled,
 COALESCE(w.available_cents,0) AS "balanceCents",
 (SELECT count(*) FROM login_codes l WHERE l.tenant_id=a.tenant_id AND l.deleted_at IS NULL) AS "codeCount",
 (SELECT count(*) FROM platform_accounts p WHERE p.tenant_id=a.tenant_id AND p.removed_at IS NULL) AS "accountCount",
 (SELECT max(created_at) FROM audit_logs WHERE actor=a.id::text AND action='admin.login' AND success) AS "lastLoginAt",
 NULL::timestamptz AS "createdAt"`,
		`FROM admins a JOIN tenants t ON t.id=a.tenant_id LEFT JOIN wallets w ON w.tenant_id=a.tenant_id AND w.kind='balance'
 WHERE ($1='' OR a.username ILIKE '%'||$1||'%' OR a.display_name ILIKE '%'||$1||'%' OR a.contact ILIKE '%'||$1||'%' OR t.name ILIKE '%'||$1||'%')
 AND ($2='' OR ($2='enabled' AND a.disabled_at IS NULL) OR ($2='disabled' AND a.disabled_at IS NOT NULL))
 AND ($3='' OR ($3='operator' AND a.platform_operator) OR ($3='customer' AND NOT a.platform_operator))`, search, status, role)
}

// Lock the target and protect every platform administrator, including the caller.
func operatorCustomer(c *gin.Context, tx pgx.Tx) (string, error) {
	if !operatorUserID.MatchString(c.Param("id")) {
		return "", commerceError{400, "用户标识无效"}
	}
	var tenant string
	var operator bool
	err := tx.QueryRow(c.Request.Context(), `SELECT tenant_id::text,platform_operator FROM admins WHERE id=$1 FOR UPDATE`, c.Param("id")).Scan(&tenant, &operator)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", commerceError{404, "用户不存在"}
	}
	if err != nil {
		return "", err
	}
	if operator {
		return "", commerceError{403, "管理员账号受保护，请在账户中心修改自己的密码"}
	}
	return tenant, nil
}
func (a *App) setOperatorUserStatus(c *gin.Context) {
	var b struct {
		Enabled *bool `json:"enabled"`
	}
	if c.ShouldBindJSON(&b) != nil || b.Enabled == nil {
		fail(c, 400, "请选择启用或停用")
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		if _, err := operatorCustomer(c, tx); err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		if _, err := tx.Exec(ctx, `UPDATE admins SET disabled_at=CASE WHEN $2 THEN NULL ELSE COALESCE(disabled_at,now()) END WHERE id=$1`, c.Param("id"), *b.Enabled); err != nil {
			return nil, err
		}
		if !*b.Enabled {
			if _, err := tx.Exec(ctx, `DELETE FROM admin_sessions WHERE admin_id=$1`, c.Param("id")); err != nil {
				return nil, err
			}
		}
		return true, auditTx(ctx, tx, c, identity(c).Tenant, "operations.user.status."+c.Param("id"))
	})
}
func (a *App) resetOperatorUserPassword(c *gin.Context) {
	var b struct {
		Password string `json:"password"`
	}
	if c.ShouldBindJSON(&b) != nil || !validAccountPassword(b.Password) {
		fail(c, 400, "新密码须为 8–16 位")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(b.Password), 12)
	if err != nil {
		dbError(c, err)
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		if _, err := operatorCustomer(c, tx); err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		if _, err := tx.Exec(ctx, `UPDATE admins SET password_hash=$2 WHERE id=$1`, c.Param("id"), string(hash)); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM admin_sessions WHERE admin_id=$1`, c.Param("id")); err != nil {
			return nil, err
		}
		return true, auditTx(ctx, tx, c, identity(c).Tenant, "operations.user.password."+c.Param("id"))
	})
}
