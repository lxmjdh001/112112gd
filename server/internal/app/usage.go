package app

import (
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

func (a *App) recordUsage(c *gin.Context) {
	var b struct {
		RequestID      string `json:"requestId"`
		AccountID      string `json:"accountId"`
		Provider       string `json:"provider"`
		InputChars     int    `json:"inputChars"`
		OutputChars    int    `json:"outputChars"`
		TargetLanguage string `json:"targetLanguage"`
	}
	if c.ShouldBindJSON(&b) != nil || b.InputChars < 1 || b.InputChars > 4000 || b.OutputChars < 1 || b.OutputChars > 32000 || b.Provider != "google-free" || len(b.TargetLanguage) < 2 || len(b.TargetLanguage) > 16 {
		fail(c, 400, "用量参数无效")
		return
	}
	if e := requestKey(b.RequestID); e != nil {
		commerceFail(c, e)
		return
	}
	id := identity(c)
	ctx := c.Request.Context()
	var valid bool
	if e := a.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_accounts a LEFT JOIN proxies p ON p.id=a.proxy_id JOIN login_codes l ON l.id=a.code_id WHERE a.id::text=$1 AND a.tenant_id=$2 AND a.code_id=$3 AND a.device_id=$4 AND a.connection_type='web' AND (a.proxy_id IS NULL OR p.enabled) AND l.deleted_at IS NULL AND l.enabled AND a.platform=ANY(l.allowed_platforms))`, b.AccountID, id.Tenant, id.Code, id.Device).Scan(&valid); e != nil {
		dbError(c, e)
		return
	}
	if !valid {
		fail(c, 404, "账号不属于当前设备或代理已禁用")
		return
	}
	var key string
	e := a.DB.QueryRow(ctx, `INSERT INTO usage_records(tenant_id,account_id,request_id,provider,input_chars,output_chars,target_language) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id WHERE usage_records.account_id=EXCLUDED.account_id AND usage_records.provider=EXCLUDED.provider AND usage_records.input_chars=EXCLUDED.input_chars AND usage_records.output_chars=EXCLUDED.output_chars AND usage_records.target_language=EXCLUDED.target_language RETURNING id::text`, id.Tenant, b.AccountID, b.RequestID, b.Provider, b.InputChars, b.OutputChars, b.TargetLanguage).Scan(&key)
	if e == pgx.ErrNoRows {
		fail(c, 409, "请求编号已用于其他用量记录")
		return
	}
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, true)
}
func (a *App) usageHistory(c *gin.Context) {
	a.commerceList(c, `u.id::text,a.label AS "accountName",u.provider,u.input_chars AS "inputChars",u.output_chars AS "outputChars",u.target_language AS "targetLanguage",u.created_at AS "createdAt"`, `FROM usage_records u JOIN platform_accounts a ON a.id=u.account_id WHERE u.tenant_id=$1 AND ($2='' OR a.label ILIKE '%'||$2||'%')`, identity(c).Tenant, c.Query("search"))
}
