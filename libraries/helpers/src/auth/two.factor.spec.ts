import {
  base32Decode,
  base32Encode,
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  totpAt,
  verifyTotp,
} from './two.factor';

// RFC 6238 appendix B, SHA1 secret "12345678901234567890", last 6 digits
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const vectors: Array<[number, string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('two factor', () => {
  it('round-trips base32', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
  });

  it.each(vectors)('matches RFC 6238 at t=%i', (seconds, code) => {
    expect(totpAt(RFC_SECRET, Math.floor(seconds / 30))).toBe(code);
  });

  it('accepts the current and adjacent windows only', () => {
    const now = 1234567890 * 1000;
    const step = Math.floor(1234567890 / 30);
    expect(verifyTotp(RFC_SECRET, '005924', null, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 2), null, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abc123', null, now)).toBeNull();
  });

  it('rejects a code that was already used', () => {
    const now = 1234567890 * 1000;
    const step = Math.floor(1234567890 / 30);
    expect(verifyTotp(RFC_SECRET, '005924', step, now)).toBeNull();
  });

  it('encrypts the secret with a fresh IV each time', () => {
    process.env.JWT_SECRET = 'test-secret';
    const a = encryptTwoFactorSecret(RFC_SECRET);
    const b = encryptTwoFactorSecret(RFC_SECRET);
    expect(a).not.toBe(b);
    expect(decryptTwoFactorSecret(a)).toBe(RFC_SECRET);
  });

  it('normalizes recovery codes before hashing', () => {
    const [code] = generateRecoveryCodes(1);
    expect(code).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(hashRecoveryCode(code.toUpperCase().replace('-', ' '))).toBe(
      hashRecoveryCode(code)
    );
  });
});
