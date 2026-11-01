// Bolt Advantage: client cost report (metered API use per client and channel).
import { Controller, Get, HttpException, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { requireOrgAdmin } from '@gitroom/nestjs-libraries/user/require.org.admin';
import { CostsService } from '@gitroom/nestjs-libraries/bolt-costs/costs.service';

@ApiTags('Costs')
@Controller('/bolt-costs')
export class BoltCostsController {
  constructor(private _costs: CostsService) {}

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
