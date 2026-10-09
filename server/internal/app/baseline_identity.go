package app

import (
	"encoding/csv"
	"fmt"
	"io"
	"net/netip"
	"regexp"
	"strings"
	"unicode/utf8"
)

var phoneChars = regexp.MustCompile(`^\+?[0-9 ()-]+$`)
var phoneNumber = regexp.MustCompile(`^[1-9][0-9]{6,14}$`)
var lidNumber = regexp.MustCompile(`^[0-9]{5,30}@lid$`)
var lineIdentity = regexp.MustCompile(`^[A-Za-z0-9._@-]{2,100}$`)

// Platform namespaces are kept separate. LID is never guessed from a phone/name.
func normalizeCustomer(platform, identifier, ip string) (string, string, error) {
	identifier = strings.TrimSpace(identifier)
	ip = strings.TrimSpace(ip)
	if platform != "whatsapp" && platform != "line" {
		return "", "", fmt.Errorf("请选择 WhatsApp 或 LINE")
	}
	if identifier != "" {
		if platform == "whatsapp" {
			identifier = strings.TrimSuffix(strings.TrimSuffix(identifier, "@s.whatsapp.net"), "@c.us")
			if !lidNumber.MatchString(identifier) {
				if !phoneChars.MatchString(identifier) {
					return "", "", fmt.Errorf("WhatsApp 账号须为含国家区号的手机号或完整 LID")
				}
				identifier = strings.NewReplacer("+", "", " ", "", "(", "", ")", "", "-", "").Replace(identifier)
				if !phoneNumber.MatchString(identifier) {
					return "", "", fmt.Errorf("WhatsApp 手机号须为 7–15 位，包含国家区号")
				}
			}
		} else if !lineIdentity.MatchString(identifier) {
			return "", "", fmt.Errorf("LINE 账号格式无效，请填写账号 ID，不能使用昵称")
		}
	}
	if ip != "" {
		addr, e := netip.ParseAddr(ip)
		if e != nil || addr.Zone() != "" || !addr.IsGlobalUnicast() || addr.IsPrivate() {
			return "", "", fmt.Errorf("请填写客户的公网 IPv4 / IPv6，不能填写端口或内网地址")
		}
		ip = addr.Unmap().String()
	}
	if identifier == "" && ip == "" {
		return "", "", fmt.Errorf("客户账号和客户 IP 至少填写一项")
	}
	return identifier, ip, nil
}

type baselineRow struct {
	Line       int    `json:"line"`
	Identifier string `json:"identifier"`
	IP         string `json:"ip"`
	Note       string `json:"note"`
	Error      string `json:"error,omitempty"`
}

func baselineRows(platform, text string) ([]baselineRow, error) {
	if !utf8.ValidString(text) {
		return nil, fmt.Errorf("请使用 UTF-8 编码的 CSV / TXT 文件")
	}
	text = strings.TrimPrefix(text, "\ufeff")
	if len(text) > 160000 {
		return nil, fmt.Errorf("每批最多 160 KB")
	}
	delimiter := ','
	if strings.Contains(text, "\t") {
		delimiter = '\t'
	}
	reader := csv.NewReader(strings.NewReader(text))
	reader.Comma = delimiter
	reader.FieldsPerRecord = -1
	reader.TrimLeadingSpace = true
	rows := []baselineRow{}
	for {
		fields, e := reader.Read()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, fmt.Errorf("CSV 格式错误，请检查引号和分隔符")
		}
		line, _ := reader.FieldPos(0)
		if len(rows) == 0 && (fields[0] == "客户账号" || fields[0] == "identifier") {
			continue
		}
		if len(rows) >= 1000 {
			return nil, fmt.Errorf("每批最多 1000 行，请分批导入")
		}
		row := baselineRow{Line: line}
		if len(fields) > 3 {
			row.Error = "每行最多三列：客户账号、客户 IP、备注"
		} else {
			row.Identifier = strings.TrimSpace(fields[0])
			if len(fields) > 1 {
				row.IP = strings.TrimSpace(fields[1])
			}
			if len(fields) > 2 {
				row.Note = strings.TrimSpace(fields[2])
			}
			if utf8.RuneCountInString(row.Note) > 200 {
				row.Error = "备注最多 200 字"
			} else {
				identifier, ip, err := normalizeCustomer(platform, row.Identifier, row.IP)
				if err != nil {
					row.Error = err.Error()
				} else {
					row.Identifier = identifier
					row.IP = ip
				}
			}
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("请填写至少一行客户账号或 IP")
	}
	return rows, nil
}
