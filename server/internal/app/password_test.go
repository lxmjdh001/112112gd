package app

import (
	"strings"
	"testing"
)

func TestAccountPasswordLength(t *testing.T) {
	for _, tc := range []struct {
		password string
		valid    bool
	}{
		{"", false}, {"1234567", false}, {"12345678", true},
		{strings.Repeat("a", 16), true}, {strings.Repeat("a", 17), false},
		{strings.Repeat("密", 8), true}, {strings.Repeat("密", 16), true},
		{strings.Repeat("密", 17), false},
	} {
		if got := validAccountPassword(tc.password); got != tc.valid {
			t.Errorf("length %d: got %v, want %v", len([]rune(tc.password)), got, tc.valid)
		}
	}
}
