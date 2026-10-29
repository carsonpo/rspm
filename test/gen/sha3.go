package main

import "crypto/sha3"

// SHA3 / SHAKE vectors against Go's crypto/sha3. Every message is a prefix of
// one seeded 400-byte buffer, so lengths 0..400 cross every rate boundary
// (72, 136, 168 and their multiples).
func init() { register("sha3", genSHA3) }

type sha3Case struct {
	Len      int    `json:"len"`
	SHA3_256 string `json:"sha3_256"`
	SHA3_512 string `json:"sha3_512"`
	SHAKE128 string `json:"shake128_32"`
	SHAKE256 string `json:"shake256_64"`
}

type shakeLong struct {
	Len      int    `json:"len"`
	OutLen   int    `json:"out_len"`
	SHAKE128 string `json:"shake128"`
	SHAKE256 string `json:"shake256"`
}

func genSHA3() any {
	msg := randBytes(rng("sha3"), 400)
	cases := make([]sha3Case, 0, 401)
	for n := 0; n <= 400; n++ {
		m := msg[:n]
		a, b := sha3.Sum256(m), sha3.Sum512(m)
		cases = append(cases, sha3Case{n, h(a[:]), h(b[:]), h(sha3.SumSHAKE128(m, 32)), h(sha3.SumSHAKE256(m, 64))})
	}
	var long []shakeLong
	for _, n := range []int{0, 3, 135, 136, 168, 200} {
		for _, out := range []int{0, 1, 135, 136, 137, 167, 168, 169, 335, 336, 337, 504, 1000} {
			long = append(long, shakeLong{n, out, h(sha3.SumSHAKE128(msg[:n], out)), h(sha3.SumSHAKE256(msg[:n], out))})
		}
	}
	return map[string]any{
		"reference": "Go standard library crypto/sha3 (go.mod toolchain), FIPS 202",
		"msg":       h(msg),
		"cases":     cases,
		"shake":     long,
	}
}
