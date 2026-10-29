package main

import (
	"fmt"
	"math/rand/v2"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

// QR code vectors against github.com/skip2/go-qrcode. Each case is a module
// matrix (rows of packed bits, hex) and the text it encodes. Contents are
// filled close to each version's capacity, so every data and error correction
// codeword is exercised, and alternate between numeric, alphanumeric, byte and
// mixed text so every segment mode appears.
func init() { register("qr", genQR) }

type qrCase struct {
	Text    string   `json:"text"`
	Version int      `json:"version"`
	Level   string   `json:"level"`
	Size    int      `json:"size"`
	Rows    []string `json:"rows"`
}

var qrLevels = []struct {
	name  string
	level qrcode.RecoveryLevel
}{{"L", qrcode.Low}, {"M", qrcode.Medium}, {"Q", qrcode.High}, {"H", qrcode.Highest}}

const alnum = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"

func qrText(r *rand.Rand, kind, n int) string {
	var b strings.Builder
	for b.Len() < n {
		switch kind {
		case 0:
			b.WriteByte(byte('0' + r.IntN(10)))
		case 1:
			b.WriteByte(alnum[r.IntN(len(alnum))])
		case 2:
			if r.IntN(8) == 0 {
				b.WriteString("é")
			} else {
				b.WriteByte(byte(0x20 + r.IntN(0x5f)))
			}
		default: // runs of each, to make the encoder switch modes
			for _, k := range []int{0, 1, 2} {
				b.WriteString(qrText(r, k, 4+r.IntN(20)))
			}
		}
	}
	return b.String()[:n]
}

// qrFill returns the longest text of this kind that still fits `version`.
func qrFill(r *rand.Rand, kind, version int, level qrcode.RecoveryLevel) *qrcode.QRCode {
	full := qrText(r, kind, 7200)
	lo, hi := 1, len(full)
	for lo < hi { // the largest n whose version is <= version
		mid := (lo + hi + 1) / 2
		q, err := qrcode.New(full[:mid], level)
		if err == nil && q.VersionNumber <= version {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	for n := lo; n > 0; n-- { // é is two bytes; don't cut it in half
		if t := full[:n]; strings.ToValidUTF8(t, "") == t {
			// Mode switching can jump past a version, so force it.
			q, err := qrcode.NewWithForcedVersion(t, version, level)
			if err != nil {
				panic(fmt.Sprintf("version %d: %v", version, err))
			}
			return q
		}
	}
	panic(fmt.Sprintf("can't fill version %d", version))
}

func qrEncode(q *qrcode.QRCode, level string) qrCase {
	q.DisableBorder = true
	bm := q.Bitmap()
	rows := make([]string, len(bm))
	for y, row := range bm {
		packed := make([]byte, (len(row)+7)/8)
		for x, dark := range row {
			if dark {
				packed[x/8] |= 0x80 >> (x % 8)
			}
		}
		rows[y] = h(packed)
	}
	return qrCase{Text: q.Content, Version: q.VersionNumber, Level: level, Size: len(bm), Rows: rows}
}

func genQR() any {
	r := rand.New(rng("qr"))
	var cases []qrCase
	// Every version at a rotating level, then every level for versions 1-10.
	for v := 1; v <= 40; v++ {
		l := qrLevels[v%4]
		cases = append(cases, qrEncode(qrFill(r, v%4, v, l.level), l.name))
	}
	for v := 1; v <= 10; v++ {
		for i, l := range qrLevels {
			cases = append(cases, qrEncode(qrFill(r, (v+i)%4, v, l.level), l.name))
		}
	}
	// What authenticator setup pages actually show.
	for _, uri := range []string{
		"otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example",
		"otpauth://totp/GitHub:octocat?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=GitHub&algorithm=SHA1&digits=6&period=30",
		"otpauth://totp/AWS%20root?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
		"otpauth://totp/Caf%C3%A9:z%C3%BCrich?secret=MFRGGZDFMZTWQ2LK&issuer=Caf%C3%A9&digits=8&algorithm=SHA256",
		"JBSWY3DPEHPK3PXP",
	} {
		for _, l := range qrLevels {
			q, err := qrcode.New(uri, l.level)
			if err != nil {
				panic(err)
			}
			cases = append(cases, qrEncode(q, l.name))
		}
	}
	return cases
}
