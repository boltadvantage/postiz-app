import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class TwoFactorRepository {
  constructor(private _twoFactor: PrismaRepository<'userTwoFactor'>) {}

  get(userId: string) {
    return this._twoFactor.model.userTwoFactor.findUnique({
      where: { userId },
    });
  }

  savePending(userId: string, secret: string) {
    return this._twoFactor.model.userTwoFactor.upsert({
      where: { userId },
      create: { userId, secret },
      update: { secret, enabledAt: null, lastUsedStep: null, recoveryCodes: '[]' },
    });
  }

  enable(userId: string, lastUsedStep: number, recoveryCodes: string[]) {
    return this._twoFactor.model.userTwoFactor.update({
      where: { userId },
      data: {
        enabledAt: new Date(),
        lastUsedStep,
        recoveryCodes: JSON.stringify(recoveryCodes),
      },
    });
  }

  // Only advances the step, so two concurrent logins can't both use one code.
  async markStepUsed(userId: string, step: number) {
    const { count } = await this._twoFactor.model.userTwoFactor.updateMany({
      where: {
        userId,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
      },
      data: { lastUsedStep: step },
    });
    return count === 1;
  }

  async replaceRecoveryCodes(
    userId: string,
    expectedCurrent: string,
    recoveryCodes: string[]
  ) {
    const { count } = await this._twoFactor.model.userTwoFactor.updateMany({
      where: { userId, recoveryCodes: expectedCurrent },
      data: { recoveryCodes: JSON.stringify(recoveryCodes) },
    });
    return count === 1;
  }

  remove(userId: string) {
    return this._twoFactor.model.userTwoFactor.deleteMany({
      where: { userId },
    });
  }
}
