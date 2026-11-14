// Bolt Advantage: client cost report (metered API use per client and channel).
import { Body, Controller, Get, HttpException, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { requireOrgAdmin } from '@gitroom/nestjs-libraries/user/require.org.admin';
import { CostsService } from '@gitroom/nestjs-libraries/bolt-costs/costs.service';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  envBudget,
  poolLimit,
  saveXBudgetSettings,
  spentToday,
  xBudgetSettings,
  xOwnerIntegrationId,
} from '@gitroom/nestjs-libraries/bolt-costs/x-billing';

@ApiTags('Costs')
@Controller('/bolt-costs')
export class BoltCostsController {
  constructor(private _costs: CostsService, private _prisma: PrismaService) {}

  /** The X budget and prices (install-wide), what's been spent today, and the X channels to pick the app owner from. */
  @Get('/x-budget')
  async xBudget(@GetOrgFromRequest() org: Organization) {
    requireOrgAdmin(org);
    return this.budgetView(org.id);
  }

  @Put('/x-budget')
  async saveXBudget(@GetOrgFromRequest() org: Organization, @Body() body: any) {
    requireOrgAdmin(org);
    if (body?.ownerIntegrationId) {
      const ok = await this._prisma.integration.count({
        where: { id: String(body.ownerIntegrationId), organizationId: org.id, providerIdentifier: 'x', deletedAt: null },
      });
      if (!ok) throw new HttpException('Pick one of your X channels', 400);
    }
    try {
      await saveXBudgetSettings(this._prisma, {
        dailyUsd: body?.dailyUsd,
        inboxUsd: body?.inboxUsd,
        timeZone: body?.timeZone,
        ...(body && 'ownerIntegrationId' in body ? { ownerIntegrationId: body.ownerIntegrationId || null } : {}),
        prices: body?.prices && typeof body.prices === 'object' ? body.prices : undefined,
      });
    } catch (e: any) {
      throw new HttpException(e?.message || 'Could not save', 400);
    }
    return this.budgetView(org.id);
  }

  private async budgetView(organizationId: string) {
    const [settings, spent, ownerId, channels] = await Promise.all([
      xBudgetSettings(this._prisma),
      spentToday(this._prisma),
      xOwnerIntegrationId(this._prisma),
      this._prisma.integration.findMany({
        where: { organizationId, providerIdentifier: 'x', deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, picture: true },
      }),
    ]);
    const round = (n: number) => Math.round(n * 10000) / 10000;
    return {
      ...settings,
      historyUsd: poolLimit(settings, 'x'),
      ownerIntegrationId: settings.ownerIntegrationId,
      effectiveOwnerId: ownerId,
      defaults: envBudget(),
      spentToday: { history: round(spent.history), inbox: round(spent.inbox), total: round(spent.total) },
      xChannels: channels,
    };
  }

  @Get('/')
  async report(@GetOrgFromRequest() org: Organization, @Query('from') from?: string, @Query('to') to?: string) {
    requireOrgAdmin(org);
    try {
      return await this._costs.report(org.id, from, to);
    } catch (e: any) {
      throw new HttpException(e?.message || 'Bad dates', 400);
    }
  }

  @Get('/export.csv')
  async csv(
    @GetOrgFromRequest() org: Organization,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('daily') daily?: string
  ) {
    requireOrgAdmin(org);
    try {
      const { filename, body } = await this._costs.csv(org.id, from, to, daily === 'true');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(body);
    } catch (e: any) {
      res.status(400).type('text/plain').send(e?.message || 'Bad dates');
    }
  }
}
