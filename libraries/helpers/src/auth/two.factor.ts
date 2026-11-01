// Bolt Advantage: authenticator-app sign-in (RFC 6238 TOTP, RFC 4648 base32).
// Works with Google Authenticator, 1Password, Authy, Microsoft Authenticator, etc.
import crypto from 'crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
// accept the previous and next 30-second window to tolerate clock drift
const DRIFT_STEPS = 1;

export function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(input: string) {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) {
      throw new Error('Invalid base32 character');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function totpAt(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto
    .createHmac('sha1', base32Decode(secret))
    .update(counter)
    .digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/**
 * Returns the matching time step, or null. Callers store the step and reject
 * any code at or before it, so a code can't be replayed.
 */
export function verifyTotp(
  secret: string,
  code: string,
  lastUsedStep?: number | null,
  now = Date.now()
): number | null {
  const clean = (code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) {
    return null;
  }
  const step = currentStep(now);
  for (let i = -DRIFT_STEPS; i <= DRIFT_STEPS; i++) {
    const candidate = step + i;
    if (lastUsedStep != null && candidate <= lastUsedStep) {
      continue;
    }
    const expected = Buffer.from(totpAt(secret, candidate));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean))) {
      return candidate;
    }
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Recovery codes: shown once, stored as sha256 hashes.
export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(5)).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
}

export function hashRecoveryCode(code: string) {
  return crypto
    .createHash('sha256')
    .update(code.toLowerCase().replace(/[\s-]/g, ''))
    .digest('hex');
}

// Secret at rest: AES-256-GCM with a key derived from JWT_SECRET.
function secretKey() {
  return crypto
    .createHash('sha256')
    .update(`postiz-2fa:${process.env.JWT_SECRET}`)
    .digest();
}

export function encryptTwoFactorSecret(plain: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('hex')).join(':');
}

export function decryptTwoFactorSecret(stored: string) {
  const [iv, tag, data] = stored.split(':').map((h) => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8'
  );
}
