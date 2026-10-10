package whatsappcloud

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

func VerifySignature(body []byte, signature, secret string) bool {
	if secret == "" || !strings.HasPrefix(signature, "sha256=") {
		return false
	}
	got, e := hex.DecodeString(strings.TrimPrefix(signature, "sha256="))
	if e != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), got)
}

type Notification struct {
	Object string  `json:"object"`
	Entry  []Entry `json:"entry"`
}
type Entry struct {
	ID      string   `json:"id"`
	Changes []Change `json:"changes"`
}
type Change struct {
	Field string `json:"field"`
	Value Value  `json:"value"`
}
type Value struct {
	Metadata struct {
		PhoneID string `json:"phone_number_id"`
	} `json:"metadata"`
	Contacts []struct {
		ID      string `json:"wa_id"`
		Profile struct {
			Name string `json:"name"`
		} `json:"profile"`
	} `json:"contacts"`
	Messages []Inbound `json:"messages"`
	Statuses []Receipt `json:"statuses"`
}
type Inbound struct {
	ID        string `json:"id"`
	From      string `json:"from"`
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Text      struct {
		Body string `json:"body"`
	} `json:"text"`
	Image, Audio, Video, Document, Sticker *Media
	Interactive                            json.RawMessage `json:"interactive"`
	Button                                 struct {
		Text string `json:"text"`
	} `json:"button"`
}
type Media struct {
	ID       string `json:"id"`
	Mime     string `json:"mime_type"`
	Caption  string `json:"caption"`
	Filename string `json:"filename"`
}
type Receipt struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	Timestamp string `json:"timestamp"`
	Recipient string `json:"recipient_id"`
	Opaque    string `json:"biz_opaque_callback_data"`
	Errors    []struct {
		Code int `json:"code"`
	} `json:"errors"`
}

func (m Inbound) Content() (string, *Media) {
	switch m.Type {
	case "text":
		return m.Text.Body, nil
	case "image":
		return "[图片]", m.Image
	case "audio":
		return "[语音]", m.Audio
	case "video":
		return "[视频]", m.Video
	case "document":
		return "[文件]", m.Document
	case "sticker":
		return "[贴纸]", m.Sticker
	case "button":
		return m.Button.Text, nil
	case "interactive":
		var v struct {
			ButtonReply struct {
				Title string `json:"title"`
			} `json:"button_reply"`
			ListReply struct {
				Title string `json:"title"`
			} `json:"list_reply"`
		}
		_ = json.Unmarshal(m.Interactive, &v)
		return v.ButtonReply.Title + v.ListReply.Title, nil
	case "location":
		return "[位置消息]", nil
	case "contacts":
		return "[联系人名片]", nil
	case "reaction":
		return "[消息回应]", nil
	default:
		return "[暂不支持的消息类型]", nil
	}
}
