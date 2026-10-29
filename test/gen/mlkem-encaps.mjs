// Helper for mlkem.go: reads [{ek, m}] (hex) on stdin and writes [{ct, ss}]
// (hex) produced by our ML-KEM-768 deterministic encapsulation. The Go
// generator then checks that Go's crypto/mlkem decapsulates each ct to the
// same ss, so nothing produced here is trusted on its own.
import { encaps } from '../../core/mlkem.js';
import { hex, unhex } from '../../core/encoding.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const out = JSON.parse(input).map(({ ek, m }) => {
  const { ct, ss } = encaps(unhex(ek), unhex(m));
  return { ct: hex(ct), ss: hex(ss) };
});
process.stdout.write(JSON.stringify(out));
