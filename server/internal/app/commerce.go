package app

import (
	"context"
	"errors"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type commerceError struct {
	status  int
	message string
}

func (e commerceError) Error() string    { return e.message }
func businessError(message string) error { return commerceError{409, message} }
func commerceFail(c *gin.Context, err error) {
	var e commerceError
	var p *pgconn.PgError
	if errors.As(err, &e) {
		fail(c, e.status, e.message)
	} else if errors.Is(err, pgx.ErrNoRows) {
		fail(c, 404, "记录不存在或不属于当前账户")
	} else if errors.As(err, &p) && p.Code == "23505" {
		fail(c, 409, "该编号或请求已使用，请刷新后核对，勿重复入账")
	} else {
		dbError(c, err)
	}
}
func (a *App) operator(c *gin.Context) {
	if !identity(c).Operator {
		fail(c, 403, "仅平台运营可执行此操作")
		return
	}
	c.Next()
}
func (a *App) commerceRoutes(r *gin.RouterGroup) {
	r.GET("/account/profile", a.accountProfile)
	r.PATCH("/account/profile", a.saveProfile)
	r.POST("/account/password", a.rate, a.changePassword)
	r.GET("/account/summary", a.accountSummary)
	r.GET("/account/billing", a.billingSummary)
	r.GET("/account/billing/days", a.billingHistory)
	r.GET("/account/ledger", a.walletHistory)
	r.GET("/account/recharges", a.rechargeHistory)
	r.POST("/account/recharges", a.createRecharge)
	r.POST("/account/recharges/:id/cancel", a.cancelRecharge)
	r.GET("/account/usage", a.usageHistory)
	r.GET("/account/purchases", a.purchaseHistory)
	r.GET("/promotion", a.promotionSummary)
	r.PATCH("/promotion", a.updatePromotion)
	r.GET("/promotion/referrals", a.referralHistory)
	r.GET("/promotion/commissions", a.commissionHistory)
	r.POST("/promotion/transfers", a.transferCommission)
	r.GET("/promotion/withdrawals", a.withdrawalHistory)
	r.POST("/promotion/withdrawals", a.createWithdrawal)
	r.POST("/promotion/withdrawals/:id/cancel", a.cancelWithdrawal)
	ops := r.Group("/operations", a.operator)
	ops.GET("/settings", a.getCommerceSettings)
	ops.PUT("/settings", a.saveCommerceSettings)
	ops.GET("/recharges", a.reviewRecharges)
	ops.POST("/recharges/:id/review", a.reviewRecharge)
	ops.GET("/withdrawals", a.reviewWithdrawals)
	ops.POST("/withdrawals/:id/review", a.reviewWithdrawal)
	ops.POST("/withdrawals/:id/destination", a.withdrawalDestination)
}

var decimalPattern = regexp.MustCompile(`^[0-9]{1,7}(\.[0-9]{1,2})?$`)

func parseMoney(value string) (int64, error) {
	if !decimalPattern.MatchString(value) {
		return 0, commerceError{400, "金额须为正数，最多两位小数"}
	}
	parts := strings.Split(value, ".")
	whole, _ := strconv.ParseInt(parts[0], 10, 64)
	cents := int64(0)
	if len(parts) == 2 {
		fraction := parts[1]
		if len(fraction) == 1 {
			fraction += "0"
		}
		cents, _ = strconv.ParseInt(fraction, 10, 64)
	}
	amount := whole*100 + cents
	if amount <= 0 || amount > 100000000 {
		return 0, commerceError{400, "单笔金额须在 0.01–1000000.00 之间"}
	}
	return amount, nil
}
func money(value int64) string {
	sign := ""
	if value < 0 {
		sign = "-"
		value = -value
	}
	return fmt.Sprintf("%s%d.%02d", sign, value/100, value%100)
}
func requestKey(value string) error {
	var key pgtype.UUID
	if len(value) != 36 || key.Scan(value) != nil {
		return commerceError{400, "请求编号无效，请刷新后重试"}
	}
	return nil
}
func auditTx(ctx context.Context, tx pgx.Tx, c *gin.Context, tenant, action string) error {
	_, err := tx.Exec(ctx, `INSERT INTO audit_logs(tenant_id,actor,action,success,ip,device) VALUES($1,$2,$3,true,$4,$5)`, tenant, identity(c).Actor, action, c.ClientIP(), truncate(c.Request.UserAgent(), 240))
	return err
}

type walletKey struct{ tenant, kind string }

// All money movements acquire wallet locks in the same order across tenants.
func lockWallets(ctx context.Context, tx pgx.Tx, keys ...walletKey) error {
	sort.Slice(keys, func(i, j int) bool { return keys[i].tenant+keys[i].kind < keys[j].tenant+keys[j].kind })
	for _, key := range keys {
		if _, err := tx.Exec(ctx, `INSERT INTO wallets(tenant_id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING`, key.tenant, key.kind); err != nil {
			return err
		}
		var n int64
		if err := tx.QueryRow(ctx, `SELECT available_cents FROM wallets WHERE tenant_id=$1 AND kind=$2 FOR UPDATE`, key.tenant, key.kind).Scan(&n); err != nil {
			return err
		}
	}
	return nil
}
func entry(ctx context.Context, tx pgx.Tx, c *gin.Context, key walletKey, event, source string, available, held int64, note string) error {
	if key.kind == "balance" && (available%100 != 0 || held%100 != 0) {
		return commerceError{400, "点数只支持整数，1 元 = 1 点，请使用整元金额"}
	}
	var balance, frozen int64
	err := tx.QueryRow(ctx, `UPDATE wallets SET available_cents=available_cents+$3,held_cents=held_cents+$4 WHERE tenant_id=$1 AND kind=$2 AND available_cents+$3>=0 AND held_cents+$4>=0 RETURNING available_cents,held_cents`, key.tenant, key.kind, available, held).Scan(&balance, &frozen)
	if errors.Is(err, pgx.ErrNoRows) {
		return businessError("可用余额不足，或资金已用于提现 / 消费，无法执行此次操作")
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO wallet_entries(tenant_id,kind,event,source_id,available_delta,held_delta,available_after,held_after,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, key.tenant, key.kind, event, source, available, held, balance, frozen, note, identity(c).Actor)
	return err
}
func (a *App) transaction(c *gin.Context, fn func(pgx.Tx) (any, error)) {
	ctx := c.Request.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		dbError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	data, err := fn(tx)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		commerceFail(c, err)
		return
	}
	ok(c, data)
}

// Real database pagination; money is serialized as decimal strings, never JS floats.
func (a *App) commerceList(c *gin.Context, fields, from string, args ...any) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("pageSize", "20"))
	if page < 1 {
		page = 1
	}
	if page > 100000 {
		page = 100000
	}
	if size < 1 || size > 100 {
		size = 20
	}
	var total int64
	if err := a.DB.QueryRow(c.Request.Context(), "SELECT count(*) "+from, args...).Scan(&total); err != nil {
		dbError(c, err)
		return
	}
	n := len(args)
	args = append(args, size, (page-1)*size)
	rows, err := a.DB.Query(c.Request.Context(), "SELECT "+fields+" "+from+fmt.Sprintf(" ORDER BY \"createdAt\" DESC,\"id\" DESC LIMIT $%d OFFSET $%d", n+1, n+2), args...)
	if err != nil {
		dbError(c, err)
		return
	}
	items, err := pgx.CollectRows(rows, pgx.RowToMap)
	if err != nil {
		dbError(c, err)
		return
	}
	if items == nil {
		items = []map[string]any{}
	}
	for _, item := range items {
		for key, value := range item {
			if strings.HasSuffix(key, "Cents") {
				if amount, valid := value.(int64); valid {
					item[strings.TrimSuffix(key, "Cents")] = money(amount)
					delete(item, key)
				}
			}
		}
	}
	ok(c, gin.H{"items": items, "total": total, "page": page, "pageSize": size})
}
