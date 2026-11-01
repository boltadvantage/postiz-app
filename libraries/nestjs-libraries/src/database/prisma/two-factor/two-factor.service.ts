import { Injectable } from '@nestjs/common';
import { TwoFactorRepository } from '@gitroom/nestjs-libraries/database/prisma/two-factor/two-factor.repository';
import {
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from '@gitroom/helpers/auth/two.factor';
import { toDataURL } from 'qrcode';
import { clearFailures, lockedFor, recordFailure } from '@gitroom/nestjs-libraries/redis/bolt.attempts';

// at most 5 wrong codes per account per 15 minutes, whatever address they come from
export const TWO_FACTOR_FAIL_LIMIT = 5;
const TWO_FACTOR_WINDOW_SECONDS = 15 * 60;
const failKey = (userId: string) => `2fa:${userId}`;

@Injectable()
export class TwoFactorService {
  constructor(private _twoFactorRepository: TwoFactorRepository) {}

  /** Seconds until this account may try another code (0 = not locked). */
  lockedFor(userId: string) {
    return lockedFor(failKey(userId), TWO_FACTOR_FAIL_LIMIT);
  }

  private async counted(userId: string, ok: boolean) {
    if (ok) await clearFailures(failKey(userId));
    else await recordFailure(failKey(userId), TWO_FACTOR_WINDOW_SECONDS);
    return ok;
  }

  async isEnabled(userId: string) {
    const record = await this._twoFactorRepository.get(userId);
    return !!record?.enabledAt;
  }

  async status(userId: string) {
    const record = await this._twoFactorRepository.get(userId);
    return {
      enabled: !!record?.enabledAt,
      enabledAt: record?.enabledAt || null,
      recoveryCodesLeft: record?.enabledAt
        ? (JSON.parse(record.recoveryCodes) as string[]).length
        : 0,
    };
  }

  /** Starts setup. Refuses while 2FA is on, so a stolen session can't swap the secret. */
  async startSetup(userId: string, email: string) {
    if (await this.isEnabled(userId)) {
      throw new Error('Two-factor authentication is already enabled');
    }
    const secret = generateTotpSecret();
    await this._twoFactorRepository.savePending(
      userId,
      encryptTwoFactorSecret(secret)
    );
    const url = otpauthUrl(secret, email, 'Postiz');
    return { secret, url, qr: await toDataURL(url, { margin: 1, width: 240 }) };
  }

  /** Confirms setup with a first code; returns the recovery codes (shown once). */
  async confirmSetup(userId: string, code: string) {
    const record = await this._twoFactorRepository.get(userId);
    if (!record || record.enabledAt) {
      throw new Error('Start setup first');
    }
    if (await this.lockedFor(userId)) {
      throw new Error('Too many wrong codes. Try again in 15 minutes.');
    }
    const step = verifyTotp(decryptTwoFactorSecret(record.secret), code);
    await this.counted(userId, step !== null);
    if (step === null) {
      throw new Error('That code is not valid. Check the time on your phone and try again.');
    }
    const codes = generateRecoveryCodes();
    await this._twoFactorRepository.enable(
      userId,
      step,
      codes.map(hashRecoveryCode)
    );
    return codes;
  }

  /** Accepts a 6-digit authenticator code or a one-time recovery code; refuses while locked out. */
  async verify(userId: string, code: string) {
    if (await this.lockedFor(userId)) return false;
    return this.counted(userId, await this.check(userId, code));
  }

  private async check(userId: string, code: string) {
    const record = await this._twoFactorRepository.get(userId);
    if (!record?.enabledAt) {
      return false;
    }

    const clean = (code || '').trim();
    if (/^\d{3}\s?\d{3}$/.test(clean)) {
      const step = verifyTotp(
        decryptTwoFactorSecret(record.secret),
        clean,
        record.lastUsedStep
      );
      return step !== null && this._twoFactorRepository.markStepUsed(userId, step);
    }

    const hashes = JSON.parse(record.recoveryCodes) as string[];
    const hash = hashRecoveryCode(clean);
    if (!hashes.includes(hash)) {
      return false;
    }
    return this._twoFactorRepository.replaceRecoveryCodes(
      userId,
      record.recoveryCodes,
      hashes.filter((h) => h !== hash)
    );
  }

  async regenerateRecoveryCodes(userId: string, code: string) {
    if (!(await this.verify(userId, code))) {
      throw new Error('That code is not valid');
    }
    const record = await this._twoFactorRepository.get(userId);
    const codes = generateRecoveryCodes();
    await this._twoFactorRepository.replaceRecoveryCodes(
      userId,
      record!.recoveryCodes,
      codes.map(hashRecoveryCode)
    );
    return codes;
  }

  async disable(userId: string, code: string) {
    if (!(await this.verify(userId, code))) {
      throw new Error('That code is not valid');
    }
    await this._twoFactorRepository.remove(userId);
  }

  /** Clears an unfinished setup (secret generated but never confirmed). */
  async cancelSetup(userId: string) {
    const record = await this._twoFactorRepository.get(userId);
    if (record && !record.enabledAt) {
      await this._twoFactorRepository.remove(userId);
    }
  }
}
