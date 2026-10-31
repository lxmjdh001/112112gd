package app

import (
	"context"
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"gongdan007/server/internal/security"
	"gongdan007/server/internal/translation"
	"gongdan007/server/internal/whatsappcloud"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type App struct {
	BillingNow      func() time.Time
	DB              *pgxpool.Pool
	Key             []byte
	mu              sync.Mutex
	attempts        map[string]attempt
	Cloud           *whatsappcloud.Client
	PublicURL       string
	TranslationHTTP *http.Client
	Translations    translation.Service
}
type attempt struct {
	n     int
	start time.Time
}
type Identity struct {
	Tenant, Actor, Device, Code string
	Operator                    bool
}

func New(db *pgxpool.Pool, key []byte) *App {
	return &App{DB: db, Key: key, attempts: map[string]attempt{}, Cloud: whatsappcloud.New(os.Getenv("WHATSAPP_GRAPH_VERSION")), PublicURL: strings.TrimRight(os.Getenv("GONGDAN_PUBLIC_URL"), "/"), TranslationHTTP: &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func ok(c *gin.Context, v any) { c.JSON(200, gin.H{"code": 0, "data": v}) }
func fail(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"code": status, "message": msg})
}
func dbError(c *gin.Context, e error) {
	slog.Error("database operation failed", "error", e)
	fail(c, 500, "操作未完成，请重试")
}
func identity(c *gin.Context) Identity { return c.MustGet("identity").(Identity) }
func (a *App) audit(c *gin.Context, tenant, actor, action string, success bool) {
	var t any
	if tenant != "" {
		t = tenant
	}
	_, e := a.DB.Exec(c.Request.Context(), `INSERT INTO audit_logs(tenant_id,actor,action,success,ip,device) VALUES($1,$2,$3,$4,$5,$6)`, t, actor, action, success, c.ClientIP(), truncate(c.Request.UserAgent(), 240))
	if e != nil {
		slog.Error("audit failed", "error", e)
	}
}
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
func (a *App) rate(c *gin.Context) {
	a.mu.Lock()
	now := time.Now()
	key := c.ClientIP() + c.FullPath()
	v := a.attempts[key]
	if now.Sub(v.start) > time.Minute {
		v = attempt{start: now}
	}
	v.n++
	a.attempts[key] = v
	if len(a.attempts) > 1000 {
		for k, x := range a.attempts {
			if now.Sub(x.start) > time.Minute {
				delete(a.attempts, k)
			}
		}
	}
	a.mu.Unlock()
	limit := 12
	if strings.HasSuffix(c.FullPath(), "/translate") {
		limit = 120
	}
	if v.n > limit {
		fail(c, 429, "尝试过于频繁，请稍后重试")
		return
	}
	c.Next()
}
func (a *App) Routes() *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())
	// Production Caddy overwrites X-Real-IP. Only a proxy on this machine may
	// supply it; external clients cannot bypass login limits with forwarded headers.
	r.SetTrustedProxies([]string{"127.0.0.1", "::1"})
	r.RemoteIPHeaders = []string{"X-Real-IP"}
	r.Use(func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		limit := int64(256 * 1024)
		if strings.HasPrefix(c.Request.URL.Path, "/api/v1/whatsapp-cloud/webhooks/") {
			limit = 2 << 20
		}
		if strings.Contains(c.Request.URL.Path, "/whatsapp-cloud/numbers/") && strings.HasSuffix(c.Request.URL.Path, "/media") && c.Request.Method == "POST" {
			limit = 23 << 20
		}
		if strings.HasPrefix(c.Request.URL.Path, "/api/v1/client/tools/assets") && (c.Request.Method == "POST" || c.Request.Method == "PATCH") {
			limit = 7 << 20
		}
		if strings.HasPrefix(c.Request.URL.Path, "/api/v1/client/accounts/") && strings.HasSuffix(c.Request.URL.Path, "/chat-archive") && c.Request.Method == "POST" {
			limit = 1_500_000
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		c.Next()
	})
	r.GET("/healthz", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), time.Second)
		defer cancel()
		if a.DB.Ping(ctx) != nil {
			fail(c, 503, "数据库未就绪")
			return
		}
		ok(c, gin.H{"status": "ready"})
	})
	v := r.Group("/api/v1")
	v.POST("/auth/login", a.rate, a.adminLogin)
	v.GET("/auth/registration", a.registrationInfo)
	v.POST("/auth/register", a.rate, a.registerAdmin)
	v.POST("/client/auth", a.rate, a.clientLogin)
	admin := v.Group("")
	admin.Use(a.auth(false))
	admin.GET("/user/info", a.userInfo)
	a.commerceRoutes(admin)
	a.baselineRoutes(admin)
	admin.GET("/translation/providers", a.translationProviders)
	admin.POST("/translation/providers/:provider/check", a.checkTranslationProvider)
	admin.GET("/translation/usage", a.translationUsage)
	admin.GET("/auth/codes", func(c *gin.Context) { ok(c, []string{"admin"}) })
	admin.POST("/auth/logout", a.adminLogout)
	admin.GET("/dashboard", a.dashboard)
	admin.GET("/platforms", a.listPlatforms)
	admin.GET("/login-codes", a.listCodes)
	admin.POST("/login-codes", a.createCode)
	admin.POST("/login-codes/move-group", a.moveCodesGroup)
	admin.POST("/login-codes/batch-delete", a.batchDeleteCodes)
	admin.DELETE("/login-codes/:id", a.deleteCode)
	admin.PATCH("/login-codes/:id", a.updateCode)
	admin.POST("/login-codes/:id/reset", a.resetCode)
	admin.POST("/login-codes/:id/copy", a.copyCode)
	admin.POST("/login-codes/:id/recover", a.rate, a.recoverCode)
	admin.GET("/login-code-groups", a.listCodeGroups)
	admin.POST("/login-code-groups", a.createCodeGroup)
	admin.PATCH("/login-code-groups/:id", a.renameCodeGroup)
	admin.DELETE("/login-code-groups/:id", a.deleteCodeGroup)
	admin.GET("/devices", a.listDevices)
	admin.DELETE("/devices/:id", a.revokeDevice)
	admin.GET("/proxies", a.listProxies)
	admin.POST("/proxies/import", a.importProxies)
	admin.PATCH("/proxies/:id", a.updateProxies)
	admin.POST("/proxies/batch", a.updateProxies)
	admin.GET("/proxy-groups", a.listProxyGroups)
	admin.POST("/proxy-groups", a.createProxyGroup)
	admin.PATCH("/proxy-groups/:id", a.renameProxyGroup)
	admin.DELETE("/proxy-groups/:id", a.deleteProxyGroup)
	admin.GET("/platform-accounts", a.listAccounts)
	admin.GET("/login-logs", a.logs)
	client := v.Group("/client")
	client.Use(a.auth(true))
	client.GET("/platforms", a.clientPlatforms)
	client.GET("/billing", a.billingSummary)
	client.GET("/accounts", a.clientAccounts)
	client.GET("/account-options", a.clientAccountOptions)
	client.POST("/proxies", a.createClientProxy)
	client.POST("/accounts", a.createClientAccount)
	client.POST("/heartbeat", a.heartbeat)
	client.POST("/logout", a.clientLogout)
	client.POST("/accounts/:id/open", a.openAccount)
	client.POST("/accounts/:id/close", a.closeClientAccount)
	client.POST("/accounts/:id/remove", a.removeClientAccount)
	client.POST("/accounts/:id/restore", a.restoreClientCloudAccount)
	client.POST("/accounts/:id/status", a.accountStatus)
	client.POST("/usage", a.recordUsage)
	client.POST("/customers/check", a.checkClientCustomer)
	client.POST("/conversations", a.recordClientConversation)
	a.workOrderRoutes(v, admin, client)
	a.teamSupervisionRoutes(admin, client)
	a.cloudRoutes(v, admin, client)
	a.customerToolsRoutes(client)
	return r
}
func (a *App) auth(client bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
		if len(raw) != 43 {
			fail(c, 401, "登录已失效，请重新登录")
			return
		}
		var id Identity
		var e error
		if client {
			e = a.DB.QueryRow(c.Request.Context(), `SELECT d.tenant_id::text,d.id::text,d.code_id::text FROM client_sessions s JOIN devices d ON d.id=s.device_id JOIN login_codes l ON l.id=d.code_id WHERE s.token_hash=$1 AND s.expires_at>now() AND d.active AND l.enabled AND l.deleted_at IS NULL AND l.expires_at>now()`, security.Hash(raw)).Scan(&id.Tenant, &id.Device, &id.Code)
			id.Actor = id.Device
		} else {
			e = a.DB.QueryRow(c.Request.Context(), `SELECT a.tenant_id::text,a.id::text,a.platform_operator FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.disabled_at IS NULL`, security.Hash(raw)).Scan(&id.Tenant, &id.Actor, &id.Operator)
		}
		if errors.Is(e, pgx.ErrNoRows) {
			if client {
				var revoked bool
				if err := a.DB.QueryRow(c.Request.Context(), `SELECT EXISTS(SELECT 1 FROM client_sessions WHERE token_hash=$1 AND revoked_reason='billing')`, security.Hash(raw)).Scan(&revoked); err != nil {
					dbError(c, err)
					return
				}
				if revoked {
					fail(c, 402, "公司点数缓冲已到期，全部账号已退登，请联系平台充值后重新登录")
					return
				}
			}
			fail(c, 401, "登录已失效，登录码可能已停用或到期")
			return
		}
		if e != nil {
			dbError(c, e)
			return
		}
		c.Set("identity", id)
		if client && !a.checkBillingAccess(c, id.Tenant) {
			return
		}
		c.Next()
	}
}
func (a *App) Bootstrap(ctx context.Context, username, password string) error {
	if username == "" || len(password) < 12 {
		return errors.New("bootstrap username required; password must contain at least 12 characters")
	}
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	_, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7007002)`)
	if e != nil {
		return e
	}
	var n int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM admins`).Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		if _, e = tx.Exec(ctx, `UPDATE admins SET platform_operator=true WHERE username=$1`, username); e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	h, e := bcrypt.GenerateFromPassword([]byte(password), 12)
	if e != nil {
		return e
	}
	var tenant string
	if e = tx.QueryRow(ctx, `INSERT INTO tenants(name) VALUES('我的团队') RETURNING id::text`).Scan(&tenant); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO admins(tenant_id,username,password_hash,platform_operator) VALUES($1,$2,$3,true)`, tenant, username, string(h)); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
