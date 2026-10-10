package app

import (
	"errors"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
)

func (a *App) copyCode(c *gin.Context) {
	id := identity(c)
	var encrypted, hash string
	err := a.DB.QueryRow(c.Request.Context(), `SELECT code_cipher,code_hash FROM login_codes WHERE id::text=$1 AND tenant_id=$2`, c.Param("id"), id.Tenant).Scan(&encrypted, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 404, "登录码不存在")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	if encrypted == "" {
		fail(c, 409, "旧版登录码未保存完整内容，请先补存原登录码")
		return
	}
	raw, err := security.Open(a.Key, encrypted)
	if err != nil || security.Hash(raw) != hash {
		// Do not include ciphertext or plaintext in logs/errors.
		fail(c, 500, "暂时无法读取登录码，请检查服务加密配置")
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code.copy", true)
	ok(c, gin.H{"code": raw})
}

func (a *App) recoverCode(c *gin.Context) {
	var b struct {
		Code string `json:"code"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "请粘贴完整原登录码")
		return
	}
	b.Code = strings.TrimSpace(b.Code)
	if len(b.Code) < 10 || len(b.Code) > 100 {
		fail(c, 400, "请粘贴完整原登录码")
		return
	}
	encrypted, err := security.Seal(a.Key, b.Code)
	if err != nil {
		dbError(c, err)
		return
	}
	id := identity(c)
	// Verify against the current hash in the same update, so a concurrent reset cannot
	// restore a previous code or change a device's authorization.
	result, err := a.DB.Exec(c.Request.Context(), `UPDATE login_codes SET code_cipher=$1 WHERE id::text=$2 AND tenant_id=$3 AND code_hash=$4`, encrypted, c.Param("id"), id.Tenant, security.Hash(b.Code))
	if err != nil {
		dbError(c, err)
		return
	}
	if result.RowsAffected() != 1 {
		fail(c, 400, "原登录码与当前记录不匹配，请检查后重试")
		return
	}
	a.audit(c, id.Tenant, id.Actor, "code.recover", true)
	ok(c, gin.H{"code": b.Code})
}
