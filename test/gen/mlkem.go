package main

import (
	"bytes"
	"crypto/mlkem"
	"crypto/sha3"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
)

// ML-KEM-768 differential vectors against Go's crypto/mlkem.
//
// Go 1.25 exposes no derandomized Encapsulate, so honest ciphertexts come from
// our JS Encaps_internal (mlkem-encaps.mjs) with seeded m, and generation fails
// unless Go decapsulates every one to the same shared secret. Tampered and
// random ciphertexts exercise implicit rejection and are decapsulated by Go
// alone. Everything is seeded, so regeneration is byte-identical.
func init() { register("mlkem768", genMLKEM768) }

type mlkemKeygen struct {
	Seed   string `json:"seed"`
	EK     string `json:"ek,omitempty"`
	EKSha3 string `json:"ek_sha3_256"`
}

type mlkemTamper struct {
	Pos int    `json:"pos"`
	Xor int    `json:"xor"`
	SS  string `json:"ss"`
}

type mlkemHonest struct {
	Seed    string        `json:"seed"`
	M       string        `json:"m"`
	CTSha3  string        `json:"ct_sha3_256"`
	SS      string        `json:"ss"`
	Tampers []mlkemTamper `json:"tampered"`
}

type mlkemRandomCT struct {
	Seed string `json:"seed"`
	CT   string `json:"ct"`
	SS   string `json:"ss"`
}

type mlkemBadEK struct {
	Seed  string `json:"seed"`
	Coeff int    `json:"coeff"` // index of the 12-bit coefficient overwritten (0..767)
	Value int    `json:"value"` // ≥ q, so the modulus check must reject
}

func decap(seed, ct []byte) []byte {
	dk, err := mlkem.NewDecapsulationKey768(seed)
	if err != nil {
		panic(err)
	}
	ss, err := dk.Decapsulate(ct)
	if err != nil {
		panic(err)
	}
	return ss
}

func setCoeff(ek []byte, i, v int) {
	b := ek[3*(i/2):]
	if i%2 == 0 {
		b[0] = byte(v)
		b[1] = b[1]&0xf0 | byte(v>>8)
	} else {
		b[1] = b[1]&0x0f | byte(v<<4)
		b[2] = byte(v >> 4)
	}
}

func genMLKEM768() any {
	r := rng("mlkem768")
	const nKeygen, nHonest, nRandom, nBadEK = 2000, 1000, 150, 200

	keygen := make([]mlkemKeygen, nKeygen)
	for i := range keygen {
		seed := randBytes(r, 64)
		dk, err := mlkem.NewDecapsulationKey768(seed)
		if err != nil {
			panic(err)
		}
		ek := dk.EncapsulationKey().Bytes()
		sum := sha3.Sum256(ek)
		keygen[i] = mlkemKeygen{Seed: h(seed), EKSha3: h(sum[:])}
		if i < 16 {
			keygen[i].EK = h(ek)
		}
	}

	type encIn struct {
		EK string `json:"ek"`
		M  string `json:"m"`
	}
	honest := make([]mlkemHonest, nHonest)
	reqs := make([]encIn, nHonest)
	seeds := make([][]byte, nHonest)
	for i := range honest {
		seeds[i] = randBytes(r, 64)
		dk, _ := mlkem.NewDecapsulationKey768(seeds[i])
		m := randBytes(r, 32)
		honest[i] = mlkemHonest{Seed: h(seeds[i]), M: h(m)}
		reqs[i] = encIn{EK: h(dk.EncapsulationKey().Bytes()), M: h(m)}
	}
	in, _ := json.Marshal(reqs)
	cmd := exec.Command("node", "mlkem-encaps.mjs")
	cmd.Stdin = bytes.NewReader(in)
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		panic(fmt.Errorf("mlkem-encaps.mjs: %w", err))
	}
	var encs []struct{ CT, SS string }
	if err := json.Unmarshal(out, &encs); err != nil || len(encs) != nHonest {
		panic("mlkem-encaps.mjs: bad output")
	}
	for i := range honest {
		ct, _ := hex.DecodeString(encs[i].CT)
		if got := h(decap(seeds[i], ct)); got != encs[i].SS {
			panic(fmt.Sprintf("case %d: Go decapsulated JS ciphertext to %s, JS said %s", i, got, encs[i].SS))
		}
		sum := sha3.Sum256(ct)
		honest[i].CTSha3, honest[i].SS = h(sum[:]), encs[i].SS
		for t := 0; t < 2; t++ {
			pos, x := int(r.Uint64()%uint64(len(ct))), int(r.Uint64()%255)+1
			bad := bytes.Clone(ct)
			bad[pos] ^= byte(x)
			honest[i].Tampers = append(honest[i].Tampers, mlkemTamper{Pos: pos, Xor: x, SS: h(decap(seeds[i], bad))})
		}
	}

	random := make([]mlkemRandomCT, nRandom)
	for i := range random {
		seed, ct := randBytes(r, 64), randBytes(r, mlkem.CiphertextSize768)
		random[i] = mlkemRandomCT{Seed: h(seed), CT: h(ct), SS: h(decap(seed, ct))}
	}

	badEK := make([]mlkemBadEK, nBadEK)
	for i := range badEK {
		seed := randBytes(r, 64)
		dk, _ := mlkem.NewDecapsulationKey768(seed)
		ek := dk.EncapsulationKey().Bytes()
		c, v := int(r.Uint64()%768), 3329+int(r.Uint64()%(4096-3329))
		setCoeff(ek, c, v)
		if _, err := mlkem.NewEncapsulationKey768(ek); err == nil {
			panic("Go accepted an out-of-range encapsulation key")
		}
		badEK[i] = mlkemBadEK{Seed: h(seed), Coeff: c, Value: v}
	}

	return map[string]any{
		"reference": "Go standard library crypto/mlkem (go.mod toolchain), FIPS 203 ML-KEM-768",
		"keygen":    keygen,
		"honest":    honest,
		"random_ct": random,
		"bad_ek":    badEK,
	}
}
