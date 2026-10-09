package app

import (
	"context"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"strings"
)

type CommerceSettings struct {
	Currency            string `json:"currency"`
	PaymentInstructions string `json:"paymentInstructions"`
	PayoutChannel       string `json:"payoutChannel"`
	RechargeEnabled     bool   `json:"rechargeEnabled"`
	WithdrawalEnabled   bool   `json:"withdrawalEnabled"`
	RegistrationEnabled bool   `json:"registrationEnabled"`
	CommissionBPS       int64  `json:"commissionBps"`
	MinRecharge         int64  `json:"-"`
	MinWithdrawal       int64  `json:"-"`
}
type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func settings(ctx context.Context, q querier, lock bool) (CommerceSettings, error) {
	var s CommerceSettings
	sql := `SELECT currency,payment_instructions,payout_channel,recharge_enabled,withdrawal_enabled,registration_enabled,commission_bps,min_recharge_cents,min_withdrawal_cents FROM commerce_settings WHERE singleton`
	if lock {
		sql += " FOR SHARE"
	}
	err := q.QueryRow(ctx, sql).Scan(&s.Currency, &s.PaymentInstructions, &s.PayoutChannel, &s.RechargeEnabled, &s.WithdrawalEnabled, &s.RegistrationEnabled, &s.CommissionBPS, &s.MinRecharge, &s.MinWithdrawal)
	return s, err
}
func (s CommerceSettings) response() gin.H {
	return gin.H{"currency": s.Currency, "paymentInstructions": s.PaymentInstructions, "payoutChannel": s.PayoutChannel, "rechargeEnabled": s.RechargeEnabled, "withdrawalEnabled": s.WithdrawalEnabled, "registrationEnabled": s.RegistrationEnabled, "commissionBps": s.CommissionBPS, "minRecharge": money(s.MinRecharge), "minWithdrawal": money(s.MinWithdrawal)}
}
func (a *App) getCommerceSettings(c *gin.Context) {
	s, e := settings(c.Request.Context(), a.DB, false)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, s.response())
}
func (a *App) saveCommerceSettings(c *gin.Context) {
	var body struct {
		CommerceSettings
		MinRecharge   string `json:"minRecharge"`
		MinWithdrawal string `json:"minWithdrawal"`
	}
	if c.ShouldBindJSON(&body) != nil {
		fail(c, 400, "设置参数无效")
		return
	}
	body.Currency = strings.ToUpper(strings.TrimSpace(body.Currency))
	body.PaymentInstructions = strings.TrimSpace(body.PaymentInstructions)
	body.PayoutChannel = strings.TrimSpace(body.PayoutChannel)
	if (body.Currency != "" && body.Currency != "USD" && body.Currency != "CNY" && body.Currency != "USDT") || body.CommissionBPS < 0 || body.CommissionBPS > 10000 || len([]rune(body.PaymentInstructions)) > 2000 || len([]rune(body.PayoutChannel)) > 80 {
		fail(c, 400, "币种、佣金比例或收款说明无效")
		return
	}
	minRecharge, e := parseMoney(body.MinRecharge)
	if e != nil {
		commerceFail(c, e)
		return
	}
	minWithdrawal, e := parseMoney(body.MinWithdrawal)
	if e != nil {
		commerceFail(c, e)
		return
	}
	if body.RechargeEnabled && (body.Currency == "" || body.PaymentInstructions == "") {
		fail(c, 400, "启用充值前请先设置币种和收款说明")
		return
	}
	if body.WithdrawalEnabled && (body.Currency == "" || body.PayoutChannel == "") {
		fail(c, 400, "启用提现前请先设置币种和提现渠道")
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		var old string
		if e := tx.QueryRow(c.Request.Context(), `SELECT currency FROM commerce_settings WHERE singleton FOR UPDATE`).Scan(&old); e != nil {
			return nil, e
		}
		if old != body.Currency {
			var used bool
			if e := tx.QueryRow(c.Request.Context(), `SELECT EXISTS(SELECT 1 FROM recharge_orders) OR EXISTS(SELECT 1 FROM wallet_entries) OR EXISTS(SELECT 1 FROM purchase_orders)`).Scan(&used); e != nil {
				return nil, e
			}
			if used {
				return nil, businessError("已有账务记录，不能更改币种")
			}
		}
		_, e := tx.Exec(c.Request.Context(), `UPDATE commerce_settings SET currency=$1,payment_instructions=$2,payout_channel=$3,recharge_enabled=$4,withdrawal_enabled=$5,registration_enabled=$6,commission_bps=$7,min_recharge_cents=$8,min_withdrawal_cents=$9,updated_at=now() WHERE singleton`, body.Currency, body.PaymentInstructions, body.PayoutChannel, body.RechargeEnabled, body.WithdrawalEnabled, body.RegistrationEnabled, body.CommissionBPS, minRecharge, minWithdrawal)
		if e != nil {
			return nil, e
		}
		return true, auditTx(c.Request.Context(), tx, c, identity(c).Tenant, "commerce.settings.update")
	})
}
