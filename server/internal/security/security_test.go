package security

import "testing"

func TestSecrets(t *testing.T) {
	key := make([]byte, 32)
	cipher, e := Seal(key, "secret-password")
	if e != nil {
		t.Fatal(e)
	}
	plain, e := Open(key, cipher)
	if e != nil || plain != "secret-password" {
		t.Fatal("round trip failed")
	}
	key[0] = 1
	if _, e = Open(key, cipher); e == nil {
		t.Fatal("wrong key accepted")
	}
	if _, e = Open(key, "bad"); e == nil {
		t.Fatal("invalid ciphertext accepted")
	}
	if len(Token()) != 43 || Hash("a") == Hash("b") {
		t.Fatal("invalid tokens")
	}
}
