package app

import (
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"gongdan007/server/internal/security"
)

func (a *App) clientAccountOptions(c *gin.Context) {
	id := identity(c)
	ctx := c.Request.Context()
	var max, used int
	err := a.DB.QueryRow(ctx, `SELECT max_accounts,(SELECT count(*) FROM platform_accounts WHERE code_id=l.id) FROM login_codes l WHERE id=$1 AND tenant_id=$2`, id.Code, id.Tenant).Scan(&max, &used)
	if err != nil {
		dbError(c, err)
		return
	}
	rows, err := a.DB.Query(ctx, `SELECT id::text,label,protocol,host,port,group_name FROM proxies WHERE tenant_id=$1 AND enabled ORDER BY created_at,id`, id.Tenant)
	if err != nil {
		dbError(c, err)
		return
	}
	defer rows.Close()
	proxies := []gin.H{}
	for rows.Next() {
		var key, label, protocol, host, group string
		var port int
		if err = rows.Scan(&key, &label, &protocol, &host, &port, &group); err != nil {
			dbError(c, err)
			return
		}
		proxies = append(proxies, gin.H{"id": key, "label": label, "protocol": protocol, "host": host, "port": port, "group": group})
	}
	if err = rows.Err(); err != nil {
		dbError(c, err)
		return
	}
	ok(c, gin.H{"maxAccounts": max, "usedAccounts": used, "proxies": proxies, "platforms": []gin.H{{"id": "whatsapp", "name": "WhatsApp"}}})
}

func (a *App) createClientAccount(c *gin.Context) {
	var body struct {
		Label     string `json:"label"`
		Platform  string `json:"platform"`
		ProxyID   string `json:"proxyId"`
		RequestID string `json:"requestId"`
	}
	if c.ShouldBindJSON(&body) != nil {
		fail(c, 400, "请填写账号名称并选择平台和代理")
		return
	}
	body.Label = strings.TrimSpace(body.Label)
	var requestID pgtype.UUID
	if body.Label == "" || utf8.RuneCountInString(body.Label) > 100 || body.Platform != "whatsapp" || body.ProxyID == "" || len(body.RequestID) != 36 || requestID.Scan(body.RequestID) != nil {
		fail(c, 400, "请填写 1–100 字的账号名称，选择 WhatsApp 和可用代理")
		return
	}
	id := identity(c)
	ctx := c.Request.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		dbError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	// Serialize account quota and authorization changes for this login code.
	var max int
	err = tx.QueryRow(ctx, `SELECT max_accounts FROM login_codes l WHERE id=$1 AND tenant_id=$2 AND enabled AND expires_at>now() FOR UPDATE`, id.Code, id.Tenant).Scan(&max)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 401, "登录码已停用或到期")
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
		fail(c, 401, "当前设备授权已失效，请重新登录")
		return
	}
	var account, label, platform, proxy, creator string
	err = tx.QueryRow(ctx, `SELECT id::text,label,platform,proxy_id::text,created_by_device_id::text FROM platform_accounts WHERE code_id=$1 AND client_request_id=$2`, id.Code, requestID).Scan(&account, &label, &platform, &proxy, &creator)
	if err == nil {
		if creator != id.Device || label != body.Label || platform != body.Platform || proxy != body.ProxyID {
			fail(c, 409, "添加请求已使用，请关闭弹窗后重新添加")
			return
		}
		ok(c, gin.H{"id": account})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		dbError(c, err)
		return
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM platform_accounts WHERE code_id=$1`, id.Code).Scan(&count); err != nil {
		dbError(c, err)
		return
	}
	if count >= max {
		fail(c, 409, "已达到当前登录码的账号额度，请联系管理员调整")
		return
	}
	err = tx.QueryRow(ctx, `SELECT id::text FROM proxies WHERE id::text=$1 AND tenant_id=$2 AND enabled FOR SHARE`, body.ProxyID, id.Tenant).Scan(&proxy)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 400, "代理不可用，请刷新后选择")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	err = tx.QueryRow(ctx, `INSERT INTO platform_accounts(tenant_id,code_id,proxy_id,device_id,label,platform,client_request_id,created_by_device_id) VALUES($1,$2,$3,$4,$5,$6,$7,$4) RETURNING id::text`, id.Tenant, id.Code, proxy, id.Device, body.Label, body.Platform, requestID).Scan(&account)
	if err != nil {
		dbError(c, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		dbError(c, err)
		return
	}
	a.audit(c, id.Tenant, id.Device, "client.account.create", true)
	ok(c, gin.H{"id": account})
}
