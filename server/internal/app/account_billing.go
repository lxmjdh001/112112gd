package app

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

var beijing = time.FixedZone("Asia/Shanghai", 8*60*60)
var billingPhone = regexp.MustCompile(`^[1-9][0-9]{6,14}$`)

func (a *App) billingTime() time.Time {
	if a.BillingNow != nil {
		return a.BillingNow()
	}
	return time.Now()
}
func billingDay(at time.Time) string { return at.In(beijing).Format("2006-01-02") }

// New point movements are integral; keep legacy fractions visible if any exist.
func pointText(cents int64) string { return strings.TrimSuffix(money(cents), ".00") }
func parsePointAmount(value string) (int64, error) {
	cents, e := parseMoney(value)
	if e != nil {
		return 0, e
	}
	if cents%100 != 0 {
		return 0, commerceError{400, "点数只支持整数，1 元 = 1 点，请使用整元金额"}
	}
	return cents, nil
}

// Registration grant lives in the same transaction as company/admin creation.
func grantRegistrationPoints(ctx context.Context, tx pgx.Tx, tenant, actor string) error {
	if e := lockWallets(ctx, tx, walletKey{tenant, "balance"}); e != nil {
		return e
	}
	var inserted string
	e := tx.QueryRow(ctx, `INSERT INTO wallet_entries(tenant_id,kind,event,source_id,available_delta,held_delta,available_after,held_after,note,actor_id)
 SELECT $1::uuid,'balance','registration_gift',$1::text,10000,0,available_cents+10000,held_cents,'新公司注册赠送 100 点',$2 FROM wallets WHERE tenant_id=$1 AND kind='balance'
 ON CONFLICT(tenant_id,kind,event,source_id) DO NOTHING RETURNING id::text`, tenant, actor).Scan(&inserted)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `UPDATE wallets SET available_cents=available_cents+10000 WHERE tenant_id=$1 AND kind='balance'`, tenant)
	return e
}

func lockBilling(ctx context.Context, tx pgx.Tx, tenant string) error {
	// All billing operations lock the wallet first, as recharge and commission do.
	if e := lockWallets(ctx, tx, walletKey{tenant, "balance"}); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `INSERT INTO account_billing_state(tenant_id) VALUES($1) ON CONFLICT DO NOTHING`, tenant)
	return e
}

func billingExpired(ctx context.Context, tx pgx.Tx, tenant, day string) (bool, error) {
	var expired bool
	e := tx.QueryRow(ctx, `SELECT s.grace_days_used=3 AND (s.covered_day IS NULL OR s.covered_day<$2::date) AND w.available_cents<100
 FROM account_billing_state s JOIN wallets w ON w.tenant_id=s.tenant_id AND w.kind='balance' WHERE s.tenant_id=$1`, tenant, day).Scan(&expired)
	return expired, e
}

func revokeForBilling(ctx context.Context, tx pgx.Tx, tenant string) error {
	for _, sql := range []string{
		`UPDATE account_billing_state SET blocked_at=COALESCE(blocked_at,now()) WHERE tenant_id=$1`,
		`UPDATE client_sessions SET expires_at=now(),revoked_reason='billing' WHERE device_id IN (SELECT id FROM devices WHERE tenant_id=$1) AND revoked_reason<>'billing'`,
		`UPDATE platform_accounts SET paused_at=now(),observed_status='closed',observed_at=now() WHERE tenant_id=$1 AND connection_type='web' AND removed_at IS NULL AND paused_at IS NULL`,
		`INSERT INTO client_account_preferences(tenant_id,device_id,account_id,paused)
   SELECT x.tenant_id,d.id,x.number_id,true FROM wa_cloud_assignments x JOIN devices d ON d.code_id=x.code_id WHERE x.tenant_id=$1
   ON CONFLICT(device_id,account_id) DO UPDATE SET paused=true`,
	} {
		if _, e := tx.Exec(ctx, sql, tenant); e != nil {
			return e
		}
	}
	return nil
}

// Read-only access does not consume a grace day. Only a verified online account does.
func (a *App) checkBillingAccess(c *gin.Context, tenant string) bool {
	ctx := c.Request.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		dbError(c, e)
		return false
	}
	defer tx.Rollback(ctx)
	if e = lockBilling(ctx, tx, tenant); e != nil {
		dbError(c, e)
		return false
	}
	expired, e := billingExpired(ctx, tx, tenant, billingDay(a.billingTime()))
	if e != nil {
		dbError(c, e)
		return false
	}
	if expired {
		if e = revokeForBilling(ctx, tx, tenant); e != nil {
			dbError(c, e)
			return false
		}
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return false
	}
	if expired {
		fail(c, 402, "点数不足且公司累计 3 天缓冲已用完，全部账号已退登。请联系平台充值后重新登录。")
		return false
	}
	return true
}

// Caller must authorize the account before charging. Timestamp always comes from the server.
func chargeAccountDay(ctx context.Context, tx pgx.Tx, tenant, account, platform, identifier string, at time.Time) error {
	if identifier == "" {
		return commerceError{409, "尚未识别登录账号，请等待账号同步或重新加载页面"}
	}
	if e := lockBilling(ctx, tx, tenant); e != nil {
		return e
	}
	day := billingDay(at)
	var exists bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM account_billing_days WHERE tenant_id=$1 AND platform=$2 AND identity=$3 AND billing_day=$4::date)`, tenant, platform, identifier, day).Scan(&exists); e != nil {
		return e
	}
	if exists {
		return nil
	}
	var cents int64
	var used int
	var grace bool
	if e := tx.QueryRow(ctx, `SELECT w.available_cents,s.grace_days_used,EXISTS(SELECT 1 FROM account_grace_days WHERE tenant_id=$1 AND billing_day=$2::date) FROM wallets w JOIN account_billing_state s USING(tenant_id) WHERE w.tenant_id=$1 AND w.kind='balance'`, tenant, day).Scan(&cents, &used, &grace); e != nil {
		return e
	}
	status, points := "paid", 1
	if cents < 100 {
		if !grace && used >= 3 {
			return commerceError{409, "公司累计 3 天缓冲已用完，剩余点数不足以上线此账号，请联系平台充值"}
		}
		status, points = "grace", 0
		if !grace {
			if _, e := tx.Exec(ctx, `INSERT INTO account_grace_days(tenant_id,billing_day) VALUES($1,$2::date)`, tenant, day); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `UPDATE account_billing_state SET grace_days_used=grace_days_used+1 WHERE tenant_id=$1`, tenant); e != nil {
				return e
			}
		}
	}
	var id string
	if e := tx.QueryRow(ctx, `INSERT INTO account_billing_days(tenant_id,platform,identity,billing_day,account_id,account_label,status,points)
 SELECT $1,$2,$3,$4::date,id,label,$6,$7 FROM platform_accounts WHERE id=$5 AND tenant_id=$1 RETURNING id::text`, tenant, platform, identifier, day, account, status, points).Scan(&id); e != nil {
		return e
	}
	if points == 1 {
		if _, e := tx.Exec(ctx, `UPDATE wallets SET available_cents=available_cents-100 WHERE tenant_id=$1 AND kind='balance'`, tenant); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `INSERT INTO wallet_entries(tenant_id,kind,event,source_id,available_delta,held_delta,available_after,held_after,note)
  SELECT tenant_id,kind,'account_day',$2,-100,0,available_cents,held_cents,$3 FROM wallets WHERE tenant_id=$1 AND kind='balance'`, tenant, id, day+" 账号上线扣除 1 点"); e != nil {
			return e
		}
	}
	_, e := tx.Exec(ctx, `UPDATE account_billing_state SET covered_day=GREATEST(COALESCE(covered_day,$2::date),$2::date),blocked_at=NULL WHERE tenant_id=$1`, tenant, day)
	return e
}

func (a *App) billingSummary(c *gin.Context) {
	data, e := a.billingSnapshot(c.Request.Context(), identity(c).Tenant)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, data)
}
func (a *App) billingSnapshot(ctx context.Context, tenant string) (gin.H, error) {
	var cents, spent, today, total int64
	var used int
	var grace bool
	var covered *time.Time
	day := billingDay(a.billingTime())
	e := a.DB.QueryRow(ctx, `SELECT COALESCE((SELECT available_cents FROM wallets WHERE tenant_id=$1 AND kind='balance'),0),
 COALESCE((SELECT sum(points) FROM account_billing_days WHERE tenant_id=$1),0)::bigint,
 (SELECT count(*) FROM account_billing_days WHERE tenant_id=$1 AND billing_day=$2::date),
 (SELECT count(*) FROM account_billing_days WHERE tenant_id=$1),
 COALESCE((SELECT grace_days_used FROM account_billing_state WHERE tenant_id=$1),0),
 EXISTS(SELECT 1 FROM account_grace_days WHERE tenant_id=$1 AND billing_day=$2::date),
 (SELECT covered_day FROM account_billing_state WHERE tenant_id=$1)`, tenant, day).Scan(&cents, &spent, &today, &total, &used, &grace, &covered)
	if e != nil {
		return nil, e
	}
	status := "normal"
	if cents < 100 {
		status = "low"
	}
	if grace && cents < 100 {
		status = "grace"
	}
	if cents < 100 && used == 3 && (covered == nil || covered.Format("2006-01-02") < day) {
		status = "blocked"
	}
	return gin.H{"points": pointText(cents), "spentPoints": spent, "todayAccounts": today, "accountDays": total, "graceDaysUsed": used, "graceDaysRemaining": 3 - used, "todayGrace": grace, "status": status, "billingDay": day, "timezone": "Asia/Shanghai", "pointPriceCny": 1, "pointsPerAccountDay": 1, "registrationGift": 100}, nil
}
func (a *App) billingHistory(c *gin.Context) {
	a.commerceList(c, `id::text,account_label AS "accountName",platform,identity AS "platformAccount",billing_day::text AS "billingDay",status,points,created_at AS "createdAt"`,
		`FROM account_billing_days WHERE tenant_id=$1 AND ($2='' OR account_label ILIKE '%'||$2||'%' OR identity ILIKE '%'||$2||'%')`, identity(c).Tenant, strings.TrimSpace(c.Query("search")))
}
