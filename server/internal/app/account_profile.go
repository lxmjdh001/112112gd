package app

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
	"gongdan007/server/internal/security"
	"regexp"
	"strings"
)

func (a *App) accountProfile(c *gin.Context) {
	id := identity(c)
	var username, name, contact, team string
	e := a.DB.QueryRow(c.Request.Context(), `SELECT a.username,a.display_name,a.contact,t.name FROM admins a JOIN tenants t ON a.tenant_id=t.id WHERE a.id=$1`, id.Actor).Scan(&username, &name, &contact, &team)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"username": username, "displayName": name, "contact": contact, "teamName": team, "isOperator": id.Operator})
}
func (a *App) saveProfile(c *gin.Context) {
	var b struct {
		DisplayName string `json:"displayName"`
		Contact     string `json:"contact"`
		TeamName    string `json:"teamName"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "资料无效")
		return
	}
	b.DisplayName = strings.TrimSpace(b.DisplayName)
	b.Contact = strings.TrimSpace(b.Contact)
	b.TeamName = strings.TrimSpace(b.TeamName)
	if b.TeamName == "" || len([]rune(b.TeamName)) > 100 || len([]rune(b.DisplayName)) > 80 || len([]rune(b.Contact)) > 150 {
		fail(c, 400, "请填写团队名称，资料长度超出限制")
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		id := identity(c)
		ctx := c.Request.Context()
		if _, e := tx.Exec(ctx, `UPDATE admins SET display_name=$1,contact=$2 WHERE id=$3`, b.DisplayName, b.Contact, id.Actor); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, `UPDATE tenants SET name=$1 WHERE id=$2`, b.TeamName, id.Tenant); e != nil {
			return nil, e
		}
		return true, auditTx(ctx, tx, c, id.Tenant, "account.profile.update")
	})
}
func (a *App) changePassword(c *gin.Context) {
	var b struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if c.ShouldBindJSON(&b) != nil || len(b.CurrentPassword) > 72 || len(b.NewPassword) < 12 || len(b.NewPassword) > 72 {
		fail(c, 400, "新密码须为 12–72 字节")
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		id := identity(c)
		ctx := c.Request.Context()
		var hash string
		if e := tx.QueryRow(ctx, `SELECT password_hash FROM admins WHERE id=$1 FOR UPDATE`, id.Actor).Scan(&hash); e != nil {
			return nil, e
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(b.CurrentPassword)) != nil {
			return nil, commerceError{400, "当前密码不正确"}
		}
		next, e := bcrypt.GenerateFromPassword([]byte(b.NewPassword), 12)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE admins SET password_hash=$1 WHERE id=$2`, string(next), id.Actor); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `DELETE FROM admin_sessions WHERE admin_id=$1 AND token_hash<>$2`, id.Actor, security.Hash(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))); e != nil {
			return nil, e
		}
		return true, auditTx(ctx, tx, c, id.Tenant, "account.password.update")
	})
}
func (a *App) registrationInfo(c *gin.Context) {
	s, e := settings(c.Request.Context(), a.DB, false)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"enabled": s.RegistrationEnabled})
}

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{3,49}$`)

func (a *App) registerAdmin(c *gin.Context) {
	var b struct {
		Username     string `json:"username"`
		Password     string `json:"password"`
		TeamName     string `json:"teamName"`
		ReferralCode string `json:"referralCode"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "注册参数无效")
		return
	}
	b.Username = strings.TrimSpace(b.Username)
	b.TeamName = strings.TrimSpace(b.TeamName)
	b.ReferralCode = strings.TrimSpace(b.ReferralCode)
	if !usernamePattern.MatchString(b.Username) || len(b.Password) < 12 || len(b.Password) > 72 || b.TeamName == "" || len([]rune(b.TeamName)) > 100 || len(b.ReferralCode) > 64 {
		fail(c, 400, "账号须为 4–50 位字母、数字或 ._-，密码 12–72 字节，并填写团队名称")
		return
	}
	s, e := settings(c.Request.Context(), a.DB, false)
	if e != nil {
		dbError(c, e)
		return
	}
	if !s.RegistrationEnabled {
		fail(c, 403, "注册暂未开放，请联系平台运营")
		return
	}
	hash, e := bcrypt.GenerateFromPassword([]byte(b.Password), 12)
	if e != nil {
		dbError(c, e)
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		ctx := c.Request.Context()
		s, e := settings(ctx, tx, true)
		if e != nil {
			return nil, e
		}
		if !s.RegistrationEnabled {
			return nil, commerceError{403, "注册暂未开放"}
		}
		var referrer string
		if b.ReferralCode != "" {
			e = tx.QueryRow(ctx, `SELECT tenant_id::text FROM referral_profiles WHERE code=$1 AND enabled FOR SHARE`, b.ReferralCode).Scan(&referrer)
			if errors.Is(e, pgx.ErrNoRows) {
				return nil, commerceError{400, "推广链接已停用或无效，请核对后注册"}
			}
			if e != nil {
				return nil, e
			}
		}
		var tenant, actor string
		if e = tx.QueryRow(ctx, `INSERT INTO tenants(name) VALUES($1) RETURNING id::text`, b.TeamName).Scan(&tenant); e != nil {
			return nil, e
		}
		if e = tx.QueryRow(ctx, `INSERT INTO admins(tenant_id,username,password_hash) VALUES($1,$2,$3) RETURNING id::text`, tenant, b.Username, string(hash)).Scan(&actor); e != nil {
			return nil, e
		}
		if e = grantRegistrationPoints(ctx, tx, tenant, actor); e != nil {
			return nil, e
		}
		if referrer != "" {
			if _, e = tx.Exec(ctx, `INSERT INTO referrals(referred_tenant_id,referrer_tenant_id,code) VALUES($1,$2,$3)`, tenant, referrer, b.ReferralCode); e != nil {
				return nil, e
			}
		}
		_, e = tx.Exec(ctx, `INSERT INTO audit_logs(tenant_id,actor,action,success,ip,device) VALUES($1,$2,'admin.register',true,$3,$4)`, tenant, actor, c.ClientIP(), truncate(c.Request.UserAgent(), 240))
		return true, e
	})
}
