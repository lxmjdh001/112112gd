package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/whatsappcloud"
)

func (a *App) RunCloudOutbox(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, e := a.DB.Exec(ctx, `UPDATE wa_cloud_messages SET status='unknown',error='发送进程中断，结果待确认；请核对后再发送' WHERE status='sending' AND sending_at<now()-interval '2 minutes'`); e != nil {
				continue
			}
			for i := 0; i < 10; i++ {
				worked, e := a.processCloudSend(ctx)
				if e != nil {
					slog.Error("cloud outbox operation failed", "error", e)
					break
				}
				if !worked {
					break
				}
			}
		}
	}
}
func (a *App) processCloudSend(parent context.Context) (bool, error) {
	ctx, cancel := context.WithTimeout(parent, 25*time.Second)
	defer cancel()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	var id, tenant, number, code, kind, chat, actor string
	var payload json.RawMessage
	var attempts int
	e = tx.QueryRow(ctx, `SELECT id::text,tenant_id::text,number_id::text,COALESCE(source_code_id::text,''),kind,chat_id::text,payload,attempts,actor FROM wa_cloud_messages WHERE status='queued' AND next_attempt_at<=now() ORDER BY seq FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&id, &tenant, &number, &code, &kind, &chat, &payload, &attempts, &actor)
	if e == pgx.ErrNoRows {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	var enabled, authorized bool
	var inbound *time.Time
	e = tx.QueryRow(ctx, `SELECT n.enabled,($3='' OR EXISTS(SELECT 1 FROM wa_cloud_assignments x JOIN login_codes l ON l.id=x.code_id JOIN devices d ON d.code_id=l.id AND d.id::text=$4 AND d.active WHERE x.number_id=n.id AND x.code_id::text=$3 AND x.tenant_id=n.tenant_id AND l.enabled AND l.deleted_at IS NULL AND l.expires_at>now() AND 'whatsapp_cloud'=ANY(l.allowed_platforms))),ch.last_inbound_at FROM wa_cloud_numbers n JOIN wa_cloud_chats ch ON ch.number_id=n.id WHERE n.id=$1 AND ch.id=$2`, number, chat, code, actor).Scan(&enabled, &authorized, &inbound)
	if e != nil {
		return false, e
	}
	rejection := ""
	if !enabled || !authorized {
		rejection = "号码已停用或登录码授权已撤销，消息未发送"
	} else if kind != "template" && (inbound == nil || time.Since(*inbound) >= 24*time.Hour) {
		rejection = "已超出 24 小时客服窗口，请改用获批模板"
	}
	if rejection != "" {
		_, e = tx.Exec(ctx, `UPDATE wa_cloud_messages SET status='failed',error=$2 WHERE id=$1`, id, rejection)
		if e != nil {
			return false, e
		}
		return true, tx.Commit(ctx)
	}
	_, e = tx.Exec(ctx, `UPDATE wa_cloud_messages SET status='sending',sending_at=now(),attempts=attempts+1,error='' WHERE id=$1`, id)
	if e != nil {
		return false, e
	}
	if e = tx.Commit(ctx); e != nil {
		return false, e
	}
	n, e := a.cloudNumber(ctx, tenant, number)
	if e != nil {
		return true, e
	}
	var message map[string]any
	if json.Unmarshal(payload, &message) != nil {
		return true, errors.New("invalid persisted cloud message")
	}
	delete(message, "localMediaId")
	delete(message, "filename")
	wire, _ := json.Marshal(message)
	meta, sendError := a.Cloud.Send(ctx, n.Token, n.PhoneID, wire)
	// Persist results even if the worker is being stopped after Meta accepted the request.
	savedCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	if sendError == nil {
		_, e = a.DB.Exec(savedCtx, `UPDATE wa_cloud_messages SET meta_id=COALESCE(meta_id,$2),status=CASE WHEN status IN ('sending','unknown') THEN 'accepted' ELSE status END,error=CASE WHEN status IN ('sending','unknown') THEN '' ELSE error END WHERE id=$1`, id, meta)
		if e != nil {
			return true, e
		}
		// A receipt can arrive before the send response (including without opaque data).
		_, e = a.DB.Exec(savedCtx, `UPDATE wa_cloud_messages m SET status=r.status,error=r.error FROM (SELECT status,error FROM wa_cloud_receipts WHERE number_id=$1 AND meta_id=$2 ORDER BY CASE status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END DESC LIMIT 1) r WHERE m.id=$3 AND m.status NOT IN ('read','delivered')`, number, meta, id)
		return true, e
	}
	state := "unknown"
	msg := sendError.Error() + "；结果待确认，请勿立即重复发送"
	delay := time.Duration(0)
	var apiError *whatsappcloud.APIError
	if errors.As(sendError, &apiError) && apiError.HTTPStatus < 500 {
		state = "failed"
		msg = apiError.Error()
		if (apiError.HTTPStatus == 429 || apiError.Code == 130429 || apiError.Code == 131056) && attempts < 2 {
			state = "queued"
			delay = time.Duration(10*(attempts+1)) * time.Second
		}
		if apiError.Code == 190 {
			_, _ = a.DB.Exec(savedCtx, `UPDATE wa_cloud_numbers SET auth_status='invalid',last_error=$2 WHERE id=$1`, number, msg)
		}
	}
	_, e = a.DB.Exec(savedCtx, `UPDATE wa_cloud_messages SET status=$2,error=$3,next_attempt_at=$4 WHERE id=$1 AND status='sending'`, id, state, msg, time.Now().Add(delay))
	return true, e
}
