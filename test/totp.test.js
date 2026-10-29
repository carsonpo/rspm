import { totp, hotp, parseOtpauth, decodeSecret } from '../core/totp.js';
import { eq, throws } from '../tools/check.js';

const ascii = (s) => new TextEncoder().encode(s);

// RFC 4226 Appendix D
export async function rfc4226() {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let i = 0; i < 10; i++) eq(await hotp(ascii('12345678901234567890'), i), expected[i]);
}

// RFC 6238 Appendix B
export async function rfc6238() {
  const seeds = {
    SHA1: ascii('12345678901234567890'),
    SHA256: ascii('12345678901234567890123456789012'),
    SHA512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const table = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [t, s1, s256, s512] of table) {
    for (const [alg, want] of [['SHA1', s1], ['SHA256', s256], ['SHA512', s512]]) {
      const { code } = await totp({ secret: seeds[alg], algorithm: alg, digits: 8, period: 30 }, t * 1000);
      eq(code, want, `${alg} at ${t}`);
    }
  }
}

export async function otpauthUris() {
  const p = parseOtpauth('otpauth://totp/GitHub:alice%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub&period=30');
  eq(p.issuer, 'GitHub');
  eq(p.account, 'alice@example.com');
  eq((await totp(p, 59000)).code, '287082');
  eq((await totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59000)).remaining, 1);
  throws(() => parseOtpauth('otpauth://hotp/x?secret=GEZDGNBV'), /TOTP/);
  throws(() => decodeSecret('not base32!'), /base32/);
}
