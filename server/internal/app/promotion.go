package app

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
	"strings"
)

func (a *App) promotionSummary(c *gin.Context) {
	ctx := c.Request.Context()
	id := identity(c)
	s, e := settings(ctx, a.DB, false)
	if e != nil {
		dbError(c, e)
		return
	}
	// The code belongs to this team, never to a client login-code record.
	_, e = a.DB.Exec(ctx, `INSERT INTO referral_profiles(tenant_id,code) VALUES($1,$2) ON CONFLICT(tenant_id) DO NOTHING`, id.Tenant, "R-"+security.Token()[:16])
	if e != nil {
		dbError(c, e)
		return
	}
	var code string
	var enabled bool
	var available, held, total, paid, transferred, count int64
	e = a.DB.QueryRow(ctx, `SELECT p.code,p.enabled,COALESCE((SELECT available_cents FROM wallets WHERE tenant_id=$1 AND kind='commission'),0),COALESCE((SELECT held_cents FROM wallets WHERE tenant_id=$1 AND kind='commission'),0),COALESCE((SELECT sum(amount_cents) FROM commissions WHERE tenant_id=$1 AND status='credited'),0)::bigint,COALESCE((SELECT sum(amount_cents) FROM withdrawal_requests WHERE tenant_id=$1 AND status='paid'),0)::bigint,COALESCE((SELECT sum(amount_cents) FROM commission_transfers WHERE tenant_id=$1),0)::bigint,(SELECT count(*) FROM referrals WHERE referrer_tenant_id=$1) FROM referral_profiles p WHERE p.tenant_id=$1`, id.Tenant).Scan(&code, &enabled, &available, &held, &total, &paid, &transferred, &count)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"code": code, "enabled": enabled, "available": money(available), "held": money(held), "earned": money(total), "paid": money(paid), "transferred": money(transferred), "referrals": count, "settings": s.response()})
}
func (a *App) updatePromotion(c *gin.Context) {
	var b struct {
		Enabled *bool `json:"enabled"`
	}
	if c.ShouldBindJSON(&b) != nil || b.Enabled == nil {
		fail(c, 400, "请选择推广链接状态")
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		r, e := tx.Exec(c.Request.Context(), `UPDATE referral_profiles SET enabled=$1 WHERE tenant_id=$2`, *b.Enabled, identity(c).Tenant)
		if e != nil {
			return nil, e
		}
		if r.RowsAffected() == 0 {
			return nil, pgx.ErrNoRows
		}
		return true, auditTx(c.Request.Context(), tx, c, identity(c).Tenant, "promotion.link.update")
	})
}
func (a *App) referralHistory(c *gin.Context) {
	a.commerceList(c, `r.referred_tenant_id::text AS id,t.name AS "teamName",r.created_at AS "createdAt",COALESCE((SELECT sum(o.amount_cents) FROM recharge_orders o WHERE o.tenant_id=r.referred_tenant_id AND o.status='credited'),0)::bigint AS "rechargedCents",COALESCE((SELECT sum(m.amount_cents) FROM commissions m WHERE m.referred_tenant_id=r.referred_tenant_id AND m.tenant_id=r.referrer_tenant_id AND m.status='credited'),0)::bigint AS "commissionCents"`, `FROM referrals r JOIN tenants t ON t.id=r.referred_tenant_id WHERE r.referrer_tenant_id=$1 AND ($2='' OR t.name ILIKE '%'||$2||'%')`, identity(c).Tenant, c.Query("search"))
}
func (a *App) commissionHistory(c *gin.Context) {
	a.commerceList(c, `m.id::text,m.order_id::text AS "orderId",t.name AS "teamName",m.amount_cents AS "amountCents",m.rate_bps AS "rateBps",m.status,m.created_at AS "createdAt"`, `FROM commissions m JOIN tenants t ON t.id=m.referred_tenant_id WHERE m.tenant_id=$1 AND ($2='' OR m.status=$2) AND ($3='' OR t.name ILIKE '%'||$3||'%' OR m.order_id::text ILIKE '%'||$3||'%')`, identity(c).Tenant, c.Query("status"), c.Query("search"))
}
func (a *App) transferCommission(c *gin.Context) {
	var b struct {
		Amount    string `json:"amount"`
		RequestID string `json:"requestId"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "转入金额无效")
		return
	}
	amount, e := parsePointAmount(b.Amount)
	if e != nil {
		commerceFail(c, e)
		return
	}
	if e = requestKey(b.RequestID); e != nil {
		commerceFail(c, e)
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		ctx := c.Request.Context()
		id := identity(c)
		if _, e := tx.Exec(ctx, `SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE`, id.Tenant); e != nil {
			return nil, e
		}
		var key string
		var previous int64
		e := tx.QueryRow(ctx, `SELECT id::text,amount_cents FROM commission_transfers WHERE tenant_id=$1 AND request_id=$2`, id.Tenant, b.RequestID).Scan(&key, &previous)
		if e == nil {
			if previous != amount {
				return nil, businessError("此请求编号已用于其他金额")
			}
			return gin.H{"id": key}, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		balance, commission := walletKey{id.Tenant, "balance"}, walletKey{id.Tenant, "commission"}
		if e = lockWallets(ctx, tx, balance, commission); e != nil {
			return nil, e
		}
		if e = tx.QueryRow(ctx, `INSERT INTO commission_transfers(tenant_id,request_id,amount_cents) VALUES($1,$2,$3) RETURNING id::text`, id.Tenant, b.RequestID, amount).Scan(&key); e != nil {
			return nil, e
		}
		if e = entry(ctx, tx, c, commission, "transfer_out", key, -amount, 0, "佣金转入账户余额"); e != nil {
			return nil, e
		}
		if e = entry(ctx, tx, c, balance, "transfer_in", key, amount, 0, "佣金转入账户余额"); e != nil {
			return nil, e
		}
		return gin.H{"id": key}, auditTx(ctx, tx, c, id.Tenant, "commission.transfer")
	})
}

const withdrawalFields = `w.id::text,t.name AS "teamName",w.amount_cents AS "amountCents",w.currency,w.channel,w.destination_masked AS "destination",w.status,COALESCE(w.payout_reference,'') AS "payoutReference",w.review_note AS "reviewNote",w.created_at AS "createdAt",w.reviewed_at AS "reviewedAt"`

func (a *App) listWithdrawals(c *gin.Context, tenant string) {
	a.commerceList(c, withdrawalFields, `FROM withdrawal_requests w JOIN tenants t ON t.id=w.tenant_id WHERE ($1='' OR w.tenant_id::text=$1) AND ($2='' OR w.status=$2) AND ($3='' OR t.name ILIKE '%'||$3||'%' OR w.id::text ILIKE '%'||$3||'%')`, tenant, c.Query("status"), c.Query("search"))
}
func (a *App) withdrawalHistory(c *gin.Context) { a.listWithdrawals(c, identity(c).Tenant) }
func (a *App) reviewWithdrawals(c *gin.Context) { a.listWithdrawals(c, "") }
func (a *App) createWithdrawal(c *gin.Context) {
	var b struct {
		Amount      string `json:"amount"`
		RequestID   string `json:"requestId"`
		Destination string `json:"destination"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "提现参数无效")
		return
	}
	amount, e := parseMoney(b.Amount)
	if e != nil {
		commerceFail(c, e)
		return
	}
	if e = requestKey(b.RequestID); e != nil {
		commerceFail(c, e)
		return
	}
	b.Destination = strings.TrimSpace(b.Destination)
	if len([]rune(b.Destination)) < 6 || len([]rune(b.Destination)) > 300 {
		fail(c, 400, "请填写完整收款信息（6–300 字），包括账号 / 地址、姓名及必要说明")
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		ctx := c.Request.Context()
		id := identity(c)
		s, e := settings(ctx, tx, true)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE`, id.Tenant); e != nil {
			return nil, e
		}
		var key, cipher string
		var old int64
		e = tx.QueryRow(ctx, `SELECT id::text,amount_cents,destination_cipher FROM withdrawal_requests WHERE tenant_id=$1 AND request_id=$2`, id.Tenant, b.RequestID).Scan(&key, &old, &cipher)
		if e == nil {
			destination, e := security.Open(a.Key, cipher)
			if e != nil {
				return nil, e
			}
			if old != amount || destination != b.Destination {
				return nil, businessError("此请求编号已用于其他提现")
			}
			return gin.H{"id": key}, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if !s.WithdrawalEnabled || s.Currency == "" || s.PayoutChannel == "" {
			return nil, businessError("提现暂未开放")
		}
		if amount < s.MinWithdrawal {
			return nil, commerceError{400, "提现金额不能低于 " + money(s.MinWithdrawal) + " " + s.Currency}
		}
		commission := walletKey{id.Tenant, "commission"}
		if e = lockWallets(ctx, tx, commission); e != nil {
			return nil, e
		}
		cipher, e = security.Seal(a.Key, b.Destination)
		if e != nil {
			return nil, e
		}
		runes := []rune(b.Destination)
		masked := "****" + string(runes[len(runes)-4:])
		e = tx.QueryRow(ctx, `INSERT INTO withdrawal_requests(tenant_id,request_id,currency,amount_cents,channel,destination_cipher,destination_masked) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`, id.Tenant, b.RequestID, s.Currency, amount, s.PayoutChannel, cipher, masked).Scan(&key)
		if e != nil {
			return nil, e
		}
		if e = entry(ctx, tx, c, commission, "withdraw_hold", key, -amount, amount, "提现申请冻结佣金"); e != nil {
			return nil, e
		}
		return gin.H{"id": key}, auditTx(ctx, tx, c, id.Tenant, "withdrawal.request")
	})
}
func (a *App) cancelWithdrawal(c *gin.Context) {
	a.changeWithdrawal(c, "cancel", "使用者取消申请", "")
}
func (a *App) reviewWithdrawal(c *gin.Context) {
	var b struct {
		Action          string `json:"action"`
		Note            string `json:"note"`
		PayoutReference string `json:"payoutReference"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "审核参数无效")
		return
	}
	b.Note = strings.TrimSpace(b.Note)
	b.PayoutReference = strings.TrimSpace(b.PayoutReference)
	if (b.Action != "approve" && b.Action != "reject" && b.Action != "pay") || len([]rune(b.Note)) > 300 || len([]rune(b.PayoutReference)) > 150 || (b.Action == "reject" && b.Note == "") || (b.Action == "pay" && b.PayoutReference == "") {
		fail(c, 400, "拒绝需填写原因，确认已打款需填写付款流水号")
		return
	}
	a.changeWithdrawal(c, b.Action, b.Note, b.PayoutReference)
}
func (a *App) changeWithdrawal(c *gin.Context, action, note, reference string) {
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		ctx := c.Request.Context()
		id := identity(c)
		var tenant, status, ref string
		var amount int64
		e := tx.QueryRow(ctx, `SELECT tenant_id::text,status,amount_cents,COALESCE(payout_reference,'') FROM withdrawal_requests WHERE id::text=$1 AND ($2 OR tenant_id=$3) FOR UPDATE`, c.Param("id"), action != "cancel" && id.Operator, id.Tenant).Scan(&tenant, &status, &amount, &ref)
		if e != nil {
			return nil, e
		}
		target := map[string]string{"approve": "approved", "reject": "rejected", "pay": "paid", "cancel": "cancelled"}[action]
		if status == target {
			if action == "pay" && ref != reference {
				return nil, businessError("已使用其他付款流水号结算")
			}
			return true, nil
		}
		valid := (action == "approve" && status == "pending") || (action == "pay" && status == "approved") || (action == "cancel" && status == "pending") || (action == "reject" && (status == "pending" || status == "approved"))
		if !valid {
			return nil, businessError("提现状态已变更，请刷新后核对")
		}
		key := walletKey{tenant, "commission"}
		if e = lockWallets(ctx, tx, key); e != nil {
			return nil, e
		}
		if action == "cancel" || action == "reject" {
			if e = entry(ctx, tx, c, key, "withdraw_release", c.Param("id"), amount, -amount, note); e != nil {
				return nil, e
			}
		}
		if action == "pay" {
			if e = entry(ctx, tx, c, key, "withdraw_paid", c.Param("id"), 0, -amount, "已核对线下打款流水："+reference); e != nil {
				return nil, e
			}
		}
		_, e = tx.Exec(ctx, `UPDATE withdrawal_requests SET status=$1,payout_reference=CASE WHEN $2='pay' THEN $3 ELSE payout_reference END,review_note=$4,reviewed_by=$5,reviewed_at=now() WHERE id::text=$6`, target, action, reference, note, id.Actor, c.Param("id"))
		if e != nil {
			return nil, e
		}
		return true, auditTx(ctx, tx, c, tenant, "withdrawal."+action)
	})
}
func (a *App) withdrawalDestination(c *gin.Context) {
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		var cipher, tenant string
		ctx := c.Request.Context()
		if e := tx.QueryRow(ctx, `SELECT destination_cipher,tenant_id::text FROM withdrawal_requests WHERE id::text=$1`, c.Param("id")).Scan(&cipher, &tenant); e != nil {
			return nil, e
		}
		text, e := security.Open(a.Key, cipher)
		if e != nil {
			return nil, e
		}
		return gin.H{"destination": text}, auditTx(ctx, tx, c, tenant, "withdrawal.destination.view")
	})
}
