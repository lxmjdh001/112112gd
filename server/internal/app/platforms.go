package app

import (
	"github.com/gin-gonic/gin"
	"slices"
)

type platformOption struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
}

// Grantable platforms must have a working desktop adapter. Planned platforms are
// visible in the admin selector but cannot be granted until their adapter ships.
var platformCatalog = []platformOption{
	{ID: "whatsapp", Name: "WhatsApp", Available: true},
	{ID: "whatsapp_cloud", Name: "WhatsApp API", Available: true},
	{ID: "line", Name: "LINE", Available: false},
}

func enabledPlatforms(grants []string) []platformOption {
	out := []platformOption{}
	for _, p := range platformCatalog {
		if p.Available && slices.Contains(grants, p.ID) {
			out = append(out, p)
		}
	}
	return out
}
func validPlatformGrants(grants []string) bool {
	seen := map[string]bool{}
	for _, id := range grants {
		if seen[id] {
			return false
		}
		seen[id] = true
		if !slices.ContainsFunc(platformCatalog, func(p platformOption) bool { return p.ID == id && p.Available }) {
			return false
		}
	}
	return true
}
func (a *App) listPlatforms(c *gin.Context) { ok(c, platformCatalog) }
func (a *App) clientPlatforms(c *gin.Context) {
	id := identity(c)
	var grants []string
	if e := a.DB.QueryRow(c.Request.Context(), `SELECT allowed_platforms FROM login_codes WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`, id.Code, id.Tenant).Scan(&grants); e != nil {
		dbError(c, e)
		return
	}
	ok(c, enabledPlatforms(grants))
}
