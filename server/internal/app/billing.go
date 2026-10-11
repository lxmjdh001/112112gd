package app

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"strings"
)

func (a *App) accountSummary(c *gin.Context) {
	ctx := c.Request.Context()
	id := identity(c)
	s, e := settings(ctx, a.DB, false)
	if e != nil {
		dbError(c, e)
		return
	}
	var balance, held, charged, spent, chars int64
	e = a.DB.QueryRow(ctx, `SELECT COALESCE((SELECT available_cents FROM wallets WHERE tenant_id=$1 AND kind='balance'),0),COALESCE((SELECT held_cents FROM wallets WHERE tenant_id=$1 AND kind='balance'),0),COALESCE((SELECT sum(amount_cents) FROM recharge_orders WHERE tenant_id=$1 AND status='credited'),0)::bigint,COALESCE((SELECT sum(amount_cents) FROM purchase_orders WHERE tenant_id=$1 AND status='paid'),0)::bigint,COALESCE((SELECT sum(input_chars) FROM usage_records WHERE tenant_id=$1),0)::bigint`, id.Tenant).Scan(&balance, &held, &charged, &spent, &chars)
	if e != nil {
		dbError(c, e)
		return
	}
	ok(c, gin.H{"balance": money(balance), "held": money(held), "recharged": money(charged), "spent": money(spent), "translationChars": chars, "settings": s.response()})
}
func (a *App) walletHistory(c *gin.Context) {
	kind := c.DefaultQuery("kind", "balance")
	if kind != "balance" && kind != "commission" {
		fail(c, 400, "钱包类型无效")
		return
	}
	a.commerceList(c, `id::text,kind,event,source_id AS "sourceId",available_delta AS "availableDeltaCents",held_delta AS "heldDeltaCents",available_after AS "availableAfterCents",held_after AS "heldAfterCents",note,created_at AS "createdAt"`, `FROM wallet_entries WHERE tenant_id=$1 AND kind=$2 AND ($3='' OR event ILIKE '%'||$3||'%' OR source_id ILIKE '%'||$3||'%')`, identity(c).Tenant, kind, c.Query("search"))
}

const rechargeFields = `r.id::text,t.name AS "teamName",r.currency,r.amount_cents AS "amountCents",r.status,r.payment_reference AS "paymentReference",COALESCE(r.receipt_reference,'') AS "receiptReference",r.note,COALESCE(r.refund_reference,'') AS "refundReference",r.review_note AS "reviewNote",r.created_at AS "createdAt",r.reviewed_at AS "reviewedAt"`

func (a *App) listRecharges(c *gin.Context, tenant string) {
	a.commerceList(c, rechargeFields, `FROM recharge_orders r JOIN tenants t ON t.id=r.tenant_id WHERE ($1='' OR r.tenant_id::text=$1) AND ($2='' OR r.status=$2) AND ($3='' OR r.id::text ILIKE '%'||$3||'%' OR t.name ILIKE '%'||$3||'%' OR r.payment_reference ILIKE '%'||$3||'%')`, tenant, c.Query("status"), c.Query("search"))
}
func (a *App) rechargeHistory(c *gin.Context) { a.listRecharges(c, identity(c).Tenant) }
func (a *App) reviewRecharges(c *gin.Context) { a.listRecharges(c, "") }
func (a *App) createRecharge(c *gin.Context) {
	var b struct {
		Amount           string `json:"amount"`
		PaymentReference string `json:"paymentReference"`
		Note             string `json:"note"`
		RequestID        string `json:"requestId"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "充值参数无效")
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
	b.PaymentReference = strings.TrimSpace(b.PaymentReference)
	b.Note = strings.TrimSpace(b.Note)
	if b.PaymentReference == "" || len([]rune(b.PaymentReference)) > 150 || len([]rune(b.Note)) > 300 {
		fail(c, 400, "请填写付款流水号 / 付款说明，备注最多 300 字")
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
		var key, ref, note string
		var original int64
		e = tx.QueryRow(ctx, `SELECT id::text,amount_cents,payment_reference,note FROM recharge_orders WHERE tenant_id=$1 AND request_id=$2`, id.Tenant, b.RequestID).Scan(&key, &original, &ref, &note)
		if e == nil {
			if original != amount || ref != b.PaymentReference || note != b.Note {
				return nil, businessError("请求编号已用于其他充值，请重新打开弹窗")
			}
			return gin.H{"id": key}, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if !s.RechargeEnabled || s.Currency == "" {
			return nil, businessError("充值暂未开放")
		}
		if amount < s.MinRecharge {
			return nil, commerceError{400, "充值金额不能低于 " + money(s.MinRecharge) + " " + s.Currency}
		}
		e = tx.QueryRow(ctx, `INSERT INTO recharge_orders(tenant_id,request_id,currency,amount_cents,payment_reference,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`, id.Tenant, b.RequestID, s.Currency, amount, b.PaymentReference, b.Note).Scan(&key)
		if e != nil {
			return nil, e
		}
		return gin.H{"id": key}, auditTx(ctx, tx, c, id.Tenant, "recharge.request")
	})
}
func (a *App) cancelRecharge(c *gin.Context) {
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		ctx := c.Request.Context()
		id := identity(c)
		var status string
		e := tx.QueryRow(ctx, `SELECT status FROM recharge_orders WHERE id::text=$1 AND tenant_id=$2 FOR UPDATE`, c.Param("id"), id.Tenant).Scan(&status)
		if e != nil {
			return nil, e
		}
		if status == "cancelled" {
			return true, nil
		}
		if status != "pending" {
			return nil, businessError("只有待审核充值可取消")
		}
		if _, e = tx.Exec(ctx, `UPDATE recharge_orders SET status='cancelled',reviewed_at=now() WHERE id::text=$1`, c.Param("id")); e != nil {
			return nil, e
		}
		return true, auditTx(ctx, tx, c, id.Tenant, "recharge.cancel")
	})
}
func (a *App) reviewRecharge(c *gin.Context) {
	var b struct {
		Action           string `json:"action"`
		ReceiptReference string `json:"receiptReference"`
		RefundReference  string `json:"refundReference"`
		Note             string `json:"note"`
	}
	if c.ShouldBindJSON(&b) != nil {
		fail(c, 400, "审核参数无效")
		return
	}
	b.RefundReference = strings.TrimSpace(b.RefundReference)
	b.ReceiptReference = strings.TrimSpace(b.ReceiptReference)
	b.Note = strings.TrimSpace(b.Note)
	if (b.Action != "credit" && b.Action != "reject" && b.Action != "refund") || len([]rune(b.Note)) > 300 || len([]rune(b.ReceiptReference)) > 150 || len([]rune(b.RefundReference)) > 150 || (b.Action == "refund" && b.RefundReference == "") || (b.Action == "credit" && b.ReceiptReference == "") || (b.Action != "credit" && b.Note == "") {
		fail(c, 400, "确认入账需填写实收流水号，拒绝 / 退款需填写原因")
		return
	}
	a.transaction(c, func(tx pgx.Tx) (any, error) {
		ctx := c.Request.Context()
		s, e := settings(ctx, tx, true)
		if e != nil {
			return nil, e
		}
		var tenant, status, receipt, refund string
		var amount int64
		e = tx.QueryRow(ctx, `SELECT tenant_id::text,status,amount_cents,COALESCE(receipt_reference,''),COALESCE(refund_reference,'') FROM recharge_orders WHERE id::text=$1 FOR UPDATE`, c.Param("id")).Scan(&tenant, &status, &amount, &receipt, &refund)
		if e != nil {
			return nil, e
		}
		target := map[string]string{"credit": "credited", "reject": "rejected", "refund": "refunded"}[b.Action]
		if status == target {
			if b.Action == "refund" && refund != b.RefundReference {
				return nil, businessError("已使用其他退款流水号冲正")
			}
			if b.Action == "credit" && receipt != b.ReceiptReference {
				return nil, businessError("已使用其他实收流水号入账")
			}
			return true, nil
		}
		if (b.Action == "refund" && status != "credited") || (b.Action != "refund" && status != "pending") {
			return nil, businessError("订单状态已变更，请刷新后核对")
		}
		balance := walletKey{tenant, "balance"}
		var referrer string
		var commission int64
		if b.Action == "credit" && s.CommissionBPS > 0 {
			e = tx.QueryRow(ctx, `SELECT referrer_tenant_id::text FROM referrals WHERE referred_tenant_id=$1`, tenant).Scan(&referrer)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return nil, e
			}
			if referrer != "" {
				commission = amount * s.CommissionBPS / 10000
			}
		}
		if b.Action == "refund" {
			e = tx.QueryRow(ctx, `SELECT tenant_id::text,amount_cents FROM commissions WHERE order_id::text=$1 AND status='credited' FOR UPDATE`, c.Param("id")).Scan(&referrer, &commission)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return nil, e
			}
		}
		keys := []walletKey{balance}
		if commission > 0 {
			keys = append(keys, walletKey{referrer, "commission"})
		}
		if e = lockWallets(ctx, tx, keys...); e != nil {
			return nil, e
		}
		if b.Action == "credit" {
			if e = entry(ctx, tx, c, balance, "recharge", c.Param("id"), amount, 0, "充值审核入账"); e != nil {
				return nil, e
			}
			if commission > 0 {
				if _, e = tx.Exec(ctx, `INSERT INTO commissions(order_id,tenant_id,referred_tenant_id,amount_cents,rate_bps) VALUES($1,$2,$3,$4,$5)`, c.Param("id"), referrer, tenant, commission, s.CommissionBPS); e != nil {
					return nil, e
				}
				if e = entry(ctx, tx, c, walletKey{referrer, "commission"}, "commission", c.Param("id"), commission, 0, "推广充值返佣"); e != nil {
					return nil, e
				}
			}
		}
		if b.Action == "refund" {
			if e = entry(ctx, tx, c, balance, "refund", c.Param("id"), -amount, 0, b.Note); e != nil {
				return nil, e
			}
			if commission > 0 {
				if e = entry(ctx, tx, c, walletKey{referrer, "commission"}, "commission_reversal", c.Param("id"), -commission, 0, "充值退款，冲回佣金"); e != nil {
					return nil, e
				}
				if _, e = tx.Exec(ctx, `UPDATE commissions SET status='reversed' WHERE order_id::text=$1`, c.Param("id")); e != nil {
					return nil, e
				}
			}
		}
		_, e = tx.Exec(ctx, `UPDATE recharge_orders SET status=$1,receipt_reference=CASE WHEN $2='credit' THEN $3 ELSE receipt_reference END,refund_reference=CASE WHEN $2='refund' THEN $7 ELSE refund_reference END,review_note=$4,reviewed_by=$5,reviewed_at=now() WHERE id::text=$6`, target, b.Action, b.ReceiptReference, b.Note, identity(c).Actor, c.Param("id"), b.RefundReference)
		if e != nil {
			return nil, e
		}
		return true, auditTx(ctx, tx, c, tenant, "recharge."+b.Action)
	})
}
func (a *App) purchaseHistory(c *gin.Context) {
	a.commerceList(c, `id::text,product_name AS "productName",amount_cents AS "amountCents",currency,status,created_at AS "createdAt"`, `FROM purchase_orders WHERE tenant_id=$1 AND ($2='' OR product_name ILIKE '%'||$2||'%')`, identity(c).Tenant, c.Query("search"))
}
