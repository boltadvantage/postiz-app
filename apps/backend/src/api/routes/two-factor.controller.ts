// Bolt Advantage: authenticator-app settings for the signed-in user.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { User } from '@prisma/client';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ThrottlerRealIpGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import { TwoFactorService } from '@gitroom/nestjs-libraries/database/prisma/two-factor/two-factor.service';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { setAuthCookie } from '@gitroom/backend/services/auth/two.factor.session';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { lockedMessage } from '@gitroom/nestjs-libraries/redis/bolt.attempts';

@ApiTags('User')
@Controller('/user/2fa')
export class TwoFactorController {
  constructor(
    private _twoFactorService: TwoFactorService,
    private _authService: AuthService,
    private _usersService: UsersService
  ) {}

  private async refuseIfLocked(userId: string) {
    const seconds = await this._twoFactorService.lockedFor(userId);
    if (seconds) throw new HttpException(lockedMessage(seconds), 429);
  }

  @Get('/')
  status(@GetUserFromRequest() user: User) {
    return this._twoFactorService.status(user.id);
  }

  // Turning 2FA on needs the password too, so someone holding only a stolen
  // session can't enrol their own authenticator and lock the owner out.
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @Post('/setup')
  async setup(@GetUserFromRequest() user: User, @Body('password') password: string) {
    const full = await this._usersService.getUserById(user.id);
    if (full?.providerName === 'LOCAL') {
      if (!password || !full.password || !AuthChecker.comparePassword(String(password), full.password)) {
        throw new HttpException('Enter your current password to set up the authenticator app', 400);
      }
    }
    try {
      return await this._twoFactorService.startSetup(user.id, user.email);
    } catch (e: any) {
      throw new HttpException(e.message, 400);
    }
  }

  @Delete('/setup')
  async cancelSetup(@GetUserFromRequest() user: User) {
    await this._twoFactorService.cancelSetup(user.id);
    return { success: true };
  }

  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @Post('/enable')
  async enable(
    @GetUserFromRequest() user: User,
    @Body('code') code: string,
    @Res({ passthrough: true }) response: Response
  ) {
    await this.refuseIfLocked(user.id);
    let recoveryCodes: string[];
    try {
      recoveryCodes = await this._twoFactorService.confirmSetup(
        user.id,
        String(code || '')
      );
    } catch (e: any) {
      throw new HttpException(e.message, 400);
    }

    // Keep this browser signed in; every other session now has to sign in again.
    setAuthCookie(response, await this._authService.jwtAfterTwoFactor(user.id));
    return { recoveryCodes };
  }

  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @Post('/recovery-codes')
  async recoveryCodes(
    @GetUserFromRequest() user: User,
    @Body('code') code: string
  ) {
    await this.refuseIfLocked(user.id);
    try {
      return {
        recoveryCodes: await this._twoFactorService.regenerateRecoveryCodes(
          user.id,
          String(code || '')
        ),
      };
    } catch (e: any) {
      throw new HttpException(e.message, 400);
    }
  }

  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @Post('/disable')
  async disable(@GetUserFromRequest() user: User, @Body('code') code: string) {
    await this.refuseIfLocked(user.id);
    try {
      await this._twoFactorService.disable(user.id, String(code || ''));
    } catch (e: any) {
      throw new HttpException(e.message, 400);
    }
    return { success: true };
  }
}
