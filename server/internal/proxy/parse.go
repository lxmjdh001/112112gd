package proxy

import (
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
)

type Config struct {
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// Parse accepts URL, host:port and host:port:user:password. IPv6 must be bracketed.
func Parse(line, protocol string) (Config, error) {
	bad := errors.New("格式应为 主机:端口、主机:端口:用户名:密码 或完整代理 URL")
	line = strings.TrimSpace(line)
	if len(line) > 2048 || strings.ContainsAny(line, "\r\n\t ") {
		return Config{}, bad
	}
	if protocol == "" {
		protocol = "socks5"
	}
	c := Config{Protocol: protocol}
	if strings.Contains(line, "://") {
		u, e := url.Parse(line)
		if e != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return c, bad
		}
		c.Protocol = u.Scheme
		c.Host = u.Hostname()
		c.Port, _ = strconv.Atoi(u.Port())
		if u.User != nil {
			c.Username = u.User.Username()
			c.Password, _ = u.User.Password()
		}
	} else {
		rest := line
		if strings.HasPrefix(line, "[") {
			end := strings.Index(line, "]:")
			if end < 0 {
				return c, bad
			}
			c.Host = line[1:end]
			rest = line[end+2:]
		} else {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) != 2 {
				return c, bad
			}
			c.Host = parts[0]
			rest = parts[1]
		}
		parts := strings.SplitN(rest, ":", 3)
		c.Port, _ = strconv.Atoi(parts[0])
		if len(parts) == 2 {
			return c, bad
		}
		if len(parts) == 3 {
			c.Username = parts[1]
			c.Password = parts[2]
		}
	}
	if c.Protocol != "socks5" && c.Protocol != "http" && c.Protocol != "https" {
		return c, errors.New("仅支持 SOCKS5、HTTP、HTTPS")
	}
	if c.Port < 1 || c.Port > 65535 || c.Host == "" || len(c.Host) > 253 || strings.ContainsAny(c.Host, "/@?#\\") {
		return c, bad
	}
	if strings.Contains(c.Host, ":") && net.ParseIP(c.Host) == nil {
		return c, bad
	}
	if (c.Username == "") != (c.Password == "") {
		return c, errors.New("用户名和密码需要同时填写")
	}
	if ip := net.ParseIP(c.Host); ip != nil {
		c.Host = ip.String()
	} else {
		c.Host = strings.ToLower(strings.TrimRight(c.Host, "."))
	}
	if c.Host == "" {
		return c, bad
	}
	return c, nil
}
