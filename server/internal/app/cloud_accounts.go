package app

import (
	"encoding/json"
	"github.com/gin-gonic/gin"
)

func (a *App) cloudAccountRows(c *gin.Context, client bool) ([]gin.H, error) {
	id := identity(c)
	code := ""
	if client {
		code = id.Code
	}
	device := ""
	if client {
		device = id.Device
	}
	var raw []byte
	e := a.DB.QueryRow(c.Request.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(items)),'[]'::jsonb) FROM (
 SELECT n.id::text,p.label,COALESCE(pref.paused,false) AS paused,COALESCE(pref.hidden,false) AS hidden,'whatsapp' AS platform,'cloud' AS "connectionType",'' AS "proxyHost",0 AS "proxyPort",'' AS "deviceName",n.checked_at AS "observedAt",
 COALESCE((SELECT string_agg(l.label,'、') FROM wa_cloud_assignments x JOIN login_codes l ON l.id=x.code_id WHERE x.number_id=n.id AND l.deleted_at IS NULL),'未分配') AS "codeLabel",
 CASE WHEN NOT n.enabled THEN 'api_disabled' WHEN n.auth_status='valid' THEN 'api_connected' ELSE 'api_auth_error' END AS status,
 (n.enabled AND ($2='' OR EXISTS(SELECT 1 FROM login_codes l WHERE l.id::text=$2 AND 'whatsapp_cloud'=ANY(l.allowed_platforms)))) AS available,
 CASE WHEN NOT n.enabled THEN 'api_disabled' WHEN $2<>'' AND NOT EXISTS(SELECT 1 FROM login_codes l WHERE l.id::text=$2 AND 'whatsapp_cloud'=ANY(l.allowed_platforms)) THEN 'platform_not_allowed' ELSE '' END AS "unavailableReason"
 FROM wa_cloud_numbers n JOIN platform_accounts p ON p.id=n.id LEFT JOIN client_account_preferences pref ON pref.account_id=n.id AND pref.device_id::text=$3 WHERE n.tenant_id=$1 AND ($2='' OR EXISTS(SELECT 1 FROM wa_cloud_assignments x WHERE x.number_id=n.id AND x.code_id::text=$2)) ORDER BY p.created_at
 ) items`, id.Tenant, code, device).Scan(&raw)
	if e != nil {
		return nil, e
	}
	out := []gin.H{}
	e = json.Unmarshal(raw, &out)
	return out, e
}
