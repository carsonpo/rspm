package main

// Differential vectors for Argon2id and BLAKE2b from golang.org/x/crypto
// (version pinned in go.mod). x/crypto's IDKey has no secret/ad inputs, so
// those paths are covered by the RFC 9106 vector in test/argon2.test.js.

import (
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/blake2b"
)

type argonVec struct {
	Note     string `json:"note,omitempty"`
	Password string `json:"password"`
	Salt     string `json:"salt"`
	M        uint32 `json:"m"`
	T        uint32 `json:"t"`
	P        uint8  `json:"p"`
	Len      uint32 `json:"len"`
	Tag      string `json:"tag"`
}

type blakeVec struct {
	Input  string `json:"input"`
	Key    string `json:"key"`
	OutLen int    `json:"outLen"`
	Hash   string `json:"hash"`
}

func init() {
	register("argon2id", func() any {
		r := rng("argon2id")
		var out []argonVec
		add := func(note string, pw, salt []byte, m, t uint32, p uint8, n uint32) {
			out = append(out, argonVec{note, h(pw), h(salt), m, t, p, n, h(argon2.IDKey(pw, salt, t, m, p, n))})
		}
		pw, salt := []byte("password"), []byte("somesalt")
		// Minimum memory, and memory that is not a multiple of 4p, across lanes and passes.
		for p := uint8(1); p <= 4; p++ {
			for t := uint32(1); t <= 4; t++ {
				min := 8 * uint32(p)
				add("m = 8p", pw, salt, min, t, p, 32)
				add("m not a multiple of 4p", pw, salt, min+4*uint32(p)-1, t, p, 32)
				add("m = 8p + 1", pw, salt, min+1, t, p, 32)
			}
		}
		// Tag lengths around the 64-byte H' boundary and beyond.
		for _, n := range []uint32{4, 5, 16, 31, 32, 33, 63, 64, 65, 96, 127, 128, 129, 1000, 1024} {
			add("tag length", pw, salt, 32, 2, 1, n)
		}
		add("empty password", []byte{}, salt, 16, 1, 1, 32)
		add("minimum salt", pw, randBytes(r, 8), 16, 1, 1, 32)
		// Enough blocks per segment to cross the 128-address refill (seg > 128).
		add("multiple address blocks", pw, salt, 1024, 1, 1, 32)
		add("multiple address blocks, 2 lanes", pw, salt, 2048, 2, 2, 32)
		add("protocol parameters (PROTOCOL §3.3)", pw, randBytes(r, 16), 65536, 3, 1, 32)
		for i := 0; i < 300; i++ {
			p := uint8(1 + r.Uint64()%4)
			m := 8*uint32(p) + uint32(r.Uint64()%200)
			t := uint32(1 + r.Uint64()%4)
			n := uint32(4 + r.Uint64()%125)
			add("", randBytes(r, int(r.Uint64()%65)), randBytes(r, 8+int(r.Uint64()%25)), m, t, p, n)
		}
		return out
	})

	register("blake2b", func() any {
		r := rng("blake2b")
		var out []blakeVec
		add := func(in, key []byte, n int) {
			d, err := blake2b.New(n, key)
			if err != nil {
				panic(err)
			}
			d.Write(in)
			out = append(out, blakeVec{h(in), h(key), n, h(d.Sum(nil))})
		}
		// Every input length 0..300 (crossing the 128-byte block boundary twice),
		// cycling digest lengths, alternating unkeyed and keyed.
		for n := 0; n <= 300; n++ {
			var key []byte
			if n%2 == 1 {
				key = randBytes(r, 1+n%64)
			}
			add(randBytes(r, n), key, 1+n%64)
		}
		// Every digest length, unkeyed and with a maximum-length key.
		for n := 1; n <= 64; n++ {
			add([]byte("abc"), nil, n)
			add([]byte("abc"), randBytes(r, 64), n)
		}
		// Keyed with empty input: the key block is the final block.
		for _, k := range []int{1, 32, 64} {
			add([]byte{}, randBytes(r, k), 64)
		}
		// Larger inputs, so the JS wrapper's chunking is exercised.
		add(randBytes(r, 100000), nil, 64)
		add(randBytes(r, 57344*2+1), randBytes(r, 16), 32)
		return out
	})
}
