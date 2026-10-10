package app

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"gongdan007/server/internal/security"
	"gongdan007/server/internal/whatsappcloud"
)

func (a *App) cloudVerifyWebhook(c *gin.Context) {
	var id, hash string
	e := a.DB.QueryRow(c.Request.Context(), `SELECT id::text,verify_hash FROM wa_cloud_apps WHERE id::text=$1`, c.Param("app")).Scan(&id, &hash)
	if e != nil || c.Query("hub.mode") != "subscribe" || c.Query("hub.challenge") == "" || subtle.ConstantTimeCompare([]byte(hash), []byte(security.Hash(c.Query("hub.verify_token")))) != 1 {
		c.Status(403)
		return
	}
	if _, e = a.DB.Exec(c.Request.Context(), `UPDATE wa_cloud_apps SET verified_at=now() WHERE id=$1`, id); e != nil {
		c.Status(503)
		return
	}
	c.String(200, c.Query("hub.challenge"))
}
func cloudEventTime(value string) time.Time {
	n, e := strconv.ParseInt(value, 10, 64)
	if e != nil || n <= 0 {
		return time.Now().UTC()
	}
	at := time.Unix(n, 0)
	if at.After(time.Now()) {
		return time.Now().UTC()
	}
	return at
}
func (a *App) cloudWebhook(c *gin.Context) {
	var appID, tenant, cipher string
	e := a.DB.QueryRow(c.Request.Context(), `SELECT id::text,tenant_id::text,secret_cipher FROM wa_cloud_apps WHERE id::text=$1`, c.Param("app")).Scan(&appID, &tenant, &cipher)
	if e == pgx.ErrNoRows {
		c.Status(404)
		return
	}
	if e != nil {
		c.Status(503)
		return
	}
	secret, e := security.Open(a.Key, cipher)
	if e != nil {
		c.Status(503)
		return
	}
	raw, e := io.ReadAll(c.Request.Body)
	if e != nil {
		c.Status(413)
		return
	}
	if !whatsappcloud.VerifySignature(raw, c.GetHeader("X-Hub-Signature-256"), secret) {
		c.Status(403)
		return
	}
	var event whatsappcloud.Notification
	if json.Unmarshal(raw, &event) != nil || event.Object != "whatsapp_business_account" {
		c.Status(400)
		return
	}
	ctx := c.Request.Context()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		c.Status(503)
		return
	}
	defer tx.Rollback(ctx)
	for _, entry := range event.Entry {
		for _, change := range entry.Changes {
			if change.Field != "messages" {
				continue
			}
			v := change.Value
			var number string
			e = tx.QueryRow(ctx, `SELECT id::text FROM wa_cloud_numbers WHERE app_id=$1 AND tenant_id=$2 AND phone_id=$3 AND waba_id=$4`, appID, tenant, v.Metadata.PhoneID, entry.ID).Scan(&number)
			if e == pgx.ErrNoRows {
				continue
			}
			if e != nil {
				dbError(c, e)
				return
			}
			for _, m := range v.Messages {
				if m.ID == "" || len(m.ID) > 512 || m.From == "" || len(m.From) > 100 {
					continue
				}
				// Serialize tenant-wide customer detection and concurrent duplicate deliveries.
				if e = baselineLock(ctx, tx, tenant, "whatsapp"); e != nil {
					dbError(c, e)
					return
				}
				var exists bool
				if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM wa_cloud_messages WHERE tenant_id=$1 AND number_id=$2 AND meta_id=$3)`, tenant, number, m.ID).Scan(&exists); e != nil {
					dbError(c, e)
					return
				}
				if exists {
					continue
				}
				name := ""
				for _, contact := range v.Contacts {
					if contact.ID == m.From {
						name = truncate(contact.Profile.Name, 150)
						break
					}
				}
				customer := m.From
				if value, _, err := normalizeCustomer("whatsapp", m.From, ""); err == nil {
					customer = value
				}
				at := cloudEventTime(m.Timestamp)
				var chat string
				e = tx.QueryRow(ctx, `INSERT INTO wa_cloud_chats(tenant_id,number_id,customer_id,name,last_inbound_at,last_message_at,unread) VALUES($1,$2,$3,$4,$5,$5,1) ON CONFLICT(tenant_id,number_id,customer_id) DO UPDATE SET name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE wa_cloud_chats.name END,last_inbound_at=GREATEST(wa_cloud_chats.last_inbound_at,EXCLUDED.last_inbound_at),last_message_at=GREATEST(wa_cloud_chats.last_message_at,EXCLUDED.last_message_at),unread=wa_cloud_chats.unread+1 RETURNING id::text`, tenant, number, customer, name, at).Scan(&chat)
				if e != nil {
					dbError(c, e)
					return
				}
				body, media := m.Content()
				data := gin.H{}
				if media != nil && whatsappcloud.NumericID.MatchString(media.ID) {
					var mediaID string
					e = tx.QueryRow(ctx, `INSERT INTO wa_cloud_media(tenant_id,number_id,meta_id,mime,filename) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,number_id,meta_id) DO UPDATE SET mime=EXCLUDED.mime RETURNING id::text`, tenant, number, media.ID, truncate(media.Mime, 120), truncate(media.Filename, 200)).Scan(&mediaID)
					if e != nil {
						dbError(c, e)
						return
					}
					data["mediaId"] = mediaID
					data["filename"] = truncate(media.Filename, 200)
					if media.Caption != "" {
						body = media.Caption
					}
				}
				payload, _ := json.Marshal(data)
				if _, e = tx.Exec(ctx, `INSERT INTO wa_cloud_messages(tenant_id,number_id,chat_id,direction,kind,body,payload,meta_id,status,occurred_at) VALUES($1,$2,$3,'in',$4,$5,$6,$7,'received',$8)`, tenant, number, chat, truncate(m.Type, 40), truncate(body, 20000), payload, m.ID, at); e != nil {
					dbError(c, e)
					return
				}
				if _, e = recordConversation(ctx, tx, tenant, customerInput{Platform: "whatsapp", AccountID: number, Identifier: customer}); e != nil {
					dbError(c, e)
					return
				}
			}
			for _, s := range v.Statuses {
				if s.ID == "" || len(s.ID) > 512 {
					continue
				}
				switch s.Status {
				case "sent", "delivered", "read", "failed":
				default:
					continue
				}
				msg := ""
				if len(s.Errors) > 0 {
					msg = fmt.Sprintf("Meta 发送失败（错误码 %d）", s.Errors[0].Code)
				}
				if _, e = tx.Exec(ctx, `INSERT INTO wa_cloud_receipts(tenant_id,number_id,meta_id,status,recipient,request_id,error,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(number_id,meta_id,status) DO NOTHING`, tenant, number, s.ID, s.Status, truncate(s.Recipient, 100), truncate(s.Opaque, 100), msg, cloudEventTime(s.Timestamp)); e != nil {
					dbError(c, e)
					return
				}
				// Opaque request UUID reconciles a timeout/crash even before the send response was saved.
				if _, e = tx.Exec(ctx, `UPDATE wa_cloud_messages m SET meta_id=$3,status=CASE WHEN m.status='read' THEN 'read' WHEN $4='read' THEN 'read' WHEN m.status='delivered' THEN 'delivered' WHEN $4='delivered' THEN 'delivered' WHEN m.status='failed' AND $4='sent' THEN 'failed' ELSE $4 END,error=CASE WHEN $4='failed' AND m.status NOT IN ('read','delivered') THEN $7 ELSE '' END FROM wa_cloud_chats ch WHERE m.chat_id=ch.id AND m.tenant_id=$1 AND m.number_id=$2 AND m.direction='out' AND ch.customer_id=$5 AND (m.meta_id=$3 OR (m.request_id::text=$6 AND $6<>'' AND m.status IN ('sending','unknown','accepted','sent','delivered','read','failed')))`, tenant, number, s.ID, s.Status, s.Recipient, s.Opaque, msg); e != nil {
					dbError(c, e)
					return
				}
			}
		}
	}
	if _, e = tx.Exec(ctx, `UPDATE wa_cloud_apps SET last_event_at=now() WHERE id=$1`, appID); e != nil {
		dbError(c, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		dbError(c, e)
		return
	}
	c.Status(200)
}
