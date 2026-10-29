// Generates differential test vectors from pinned reference implementations.
// Development tooling only — never shipped. See ../README.md.
//
// Each generator registers itself from its own file via register() and must be
// deterministic: regenerating must produce byte-identical JSON.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sort"
)

var generators = map[string]func() any{}

func register(name string, gen func() any) { generators[name] = gen }

// rng returns a deterministic stream seeded from the generator's name.
func rng(name string) *rand.ChaCha8 { return rand.NewChaCha8(sha256.Sum256([]byte("rspm/testgen/" + name))) }

func randBytes(r *rand.ChaCha8, n int) []byte {
	b := make([]byte, n)
	r.Read(b)
	return b
}

func h(b []byte) string { return hex.EncodeToString(b) }

func main() {
	names := make([]string, 0, len(generators))
	for n := range generators {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		out, err := json.MarshalIndent(generators[n](), "", " ")
		if err != nil {
			panic(err)
		}
		path := filepath.Join("..", "vectors", n+".json")
		if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
			panic(err)
		}
		fmt.Printf("wrote %s (%d bytes)\n", path, len(out)+1)
	}
}
