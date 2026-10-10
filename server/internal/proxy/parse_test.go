package proxy

import "testing"

func TestParse(t *testing.T) {
	good := []struct {
		raw, protocol, host, user, password string
		port                                int
	}{
		{"PROXY.EXAMPLE.:1080", "socks5", "proxy.example", "", "", 1080},
		{"[::ffff:192.0.2.1]:1080", "socks5", "192.0.2.1", "", "", 1080},
		{"[2001:0db8:0:0::1]:1080", "socks5", "2001:db8::1", "", "", 1080},
		{"proxy.example:1080", "socks5", "proxy.example", "", "", 1080},
		{"proxy.example:8080:user:pass:word", "http", "proxy.example", "user", "pass:word", 8080},
		{"socks5://name:p%40ss%3Aword@proxy.example:1080", "http", "proxy.example", "name", "p@ss:word", 1080},
		{"[2001:db8::1]:8080:u:p", "https", "2001:db8::1", "u", "p", 8080},
	}
	for _, x := range good {
		p, e := Parse(x.raw, x.protocol)
		if e != nil || p.Host != x.host || p.Port != x.port || p.Username != x.user || p.Password != x.password {
			t.Fatalf("parse %s: %#v %v", x.host, p, e)
		}
	}
	for _, raw := range []string{"", "host:0", "host:65536", "host:no", "host:80:user", "socks5://host:12/path", "ftp://host:22", "host name:80", "http://u@host:80", "2001:db8::1:80"} {
		if _, e := Parse(raw, "socks5"); e == nil {
			t.Errorf("expected error for %q", raw)
		}
	}
}
