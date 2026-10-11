package app

import (
	"errors"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/proxy"
	"gongdan007/server/internal/security"
)

// Clients may add a connection, but cannot change team proxy limits or enable
// disabled connections. Credentials are saved using the same cipher as imports.
func (a *App) createClientProxy(c *gin.Context) {
	var body struct {
		Label string `json:"label"`
		proxy.Config
	}
	if c.ShouldBindJSON(&body) != nil {
		fail(c, 400, "请填写代理协议、主机和端口")
		return
	}
	body.Label = strings.TrimSpace(body.Label)
	body.Host = strings.TrimSpace(body.Host)
	if strings.HasPrefix(body.Host, "[") && strings.HasSuffix(body.Host, "]") {
		body.Host = strings.TrimSuffix(strings.TrimPrefix(body.Host, "["), "]")
	}
	if utf8.RuneCountInString(body.Label) > 100 || len(body.Host) > 253 || len(body.Username) > 256 || len(body.Password) > 1024 || strings.ContainsAny(body.Host, "\r\n\t ") {
		fail(c, 400, "代理名称、地址或认证信息格式不正确")
		return
	}
	u := url.URL{Scheme: body.Protocol, Host: net.JoinHostPort(body.Host, strconv.Itoa(body.Port))}
	if body.Username != "" || body.Password != "" {
		u.User = url.UserPassword(body.Username, body.Password)
	}
	p, err := proxy.Parse(u.String(), body.Protocol)
	if err != nil {
		fail(c, 400, "请选择 SOCKS5、HTTP 或 HTTPS，填写有效主机和 1–65535 的端口；用户名和密码需同时填写")
		return
	}
	if body.Label == "" {
		body.Label = p.Host
	}
	id := identity(c)
	ctx := c.Request.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		dbError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	var grants []string
	err = tx.QueryRow(ctx, `SELECT allowed_platforms FROM login_codes WHERE id=$1 AND tenant_id=$2 AND enabled AND deleted_at IS NULL AND expires_at>now() FOR UPDATE`, id.Code, id.Tenant).Scan(&grants)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 401, "登录权限已失效")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	if !slices.Contains(grants, "whatsapp") {
		fail(c, 403, "当前登录码没有可使用独立 IP 的平台")
		return
	}
	var authorized bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM client_sessions s JOIN devices d ON d.id=s.device_id WHERE s.token_hash=$1 AND s.expires_at>now() AND d.id=$2 AND d.code_id=$3 AND d.tenant_id=$4 AND d.active)`, security.Hash(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")), id.Device, id.Code, id.Tenant).Scan(&authorized)
	if err != nil {
		dbError(c, err)
		return
	}
	if !authorized {
		fail(c, 401, "当前设备授权已失效")
		return
	}
	if err = lockProxyHosts(ctx, tx, id.Tenant, []string{p.Host}); err != nil {
		dbError(c, err)
		return
	}

	// Content-based deduplication makes retries safe, including when a successful
	// response is lost. Use the host lock shared with imports, edits and allocation.
	rows, err := tx.Query(ctx, `SELECT id::text,password_cipher,enabled FROM proxies WHERE tenant_id=$1 AND host=$2 AND port=$3 AND protocol=$4 AND username=$5 ORDER BY enabled DESC,created_at,id FOR UPDATE`, id.Tenant, p.Host, p.Port, p.Protocol, p.Username)
	if err != nil {
		dbError(c, err)
		return
	}
	var existing string
	var disabled bool
	for rows.Next() {
		var key, cipher string
		var enabled bool
		if err = rows.Scan(&key, &cipher, &enabled); err != nil {
			break
		}
		var password string
		password, err = security.Open(a.Key, cipher)
		if err != nil {
			break
		}
		if password == p.Password {
			if enabled && existing == "" {
				existing = key
			}
			if !enabled {
				disabled = true
			}
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		dbError(c, err)
		return
	}
	if existing != "" {
		ok(c, gin.H{"id": existing})
		return
	}
	if disabled {
		fail(c, 409, "该代理已被管理员禁用，请联系管理员启用或选择其他 IP")
		return
	}
	var max int
	var anyEnabled bool
	err = tx.QueryRow(ctx, `SELECT COALESCE(MIN(max_accounts_per_platform),1),COALESCE(bool_or(enabled),true) FROM proxies WHERE tenant_id=$1 AND host=$2`, id.Tenant, p.Host).Scan(&max, &anyEnabled)
	if err != nil {
		dbError(c, err)
		return
	}
	if !anyEnabled {
		fail(c, 409, "该 IP 的代理已被管理员禁用，请联系管理员处理")
		return
	}
	cipher, err := security.Seal(a.Key, p.Password)
	if err != nil {
		dbError(c, err)
		return
	}
	var key string
	err = tx.QueryRow(ctx, `INSERT INTO proxies(tenant_id,label,protocol,host,port,username,password_cipher,max_accounts_per_platform) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`, id.Tenant, body.Label, p.Protocol, p.Host, p.Port, p.Username, cipher, max).Scan(&key)
	if err != nil {
		dbError(c, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		dbError(c, err)
		return
	}
	a.audit(c, id.Tenant, id.Device, "client.proxy.create", true)
	ok(c, gin.H{"id": key})
}
