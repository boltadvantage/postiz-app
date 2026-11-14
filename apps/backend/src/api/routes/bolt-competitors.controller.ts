// Bolt Advantage: competitors to watch, per client, and growth compared with ours.
import { Body, Controller, Delete, Get, HttpException, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { requireOrgAdmin } from '@gitroom/nestjs-libraries/user/require.org.admin';
import { CompetitorsService } from '@gitroom/nestjs-libraries/bolt-competitors/competitors.service';

const wrap = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e: any) {
    throw new HttpException(e?.message || 'Something went wrong', 400);
  }
};

@ApiTags('Bolt Competitors')
@Controller('/bolt-competitors')
export class BoltCompetitorsController {
  constructor(private _competitors: CompetitorsService) {}

  @Get('/')
  async list(@GetOrgFromRequest() org: Organization, @Query('customerId') customerId?: string, @Query('days') days?: string) {
    const opts = { customerId: customerId || undefined, days: Number(days) || 30 };
    const [competitors, ours, everyDays] = await Promise.all([
      this._competitors.list(org.id, opts),
      this._competitors.ourGrowth(org.id, opts),
      this._competitors.checkEvery(org.id),
    ]);
    return { competitors, ours, everyDays };
  }

  /** How often competitors are checked automatically: { everyDays: 1 | 3 | 7 | 14 | 30 }. */
  @Put('/schedule')
  schedule(@GetOrgFromRequest() org: Organization, @Body() body: { everyDays?: number }) {
    requireOrgAdmin(org);
    return wrap(() => this._competitors.setCheckEvery(org.id, body?.everyDays));
  }

  @Post('/')
  add(@GetOrgFromRequest() org: Organization, @Body() body: { platform?: string; handle?: string; customerId?: string | null }) {
    requireOrgAdmin(org);
    return wrap(() => this._competitors.add(org.id, body || {}));
  }

  @Post('/:id/check')
  check(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    requireOrgAdmin(org);
    return wrap(() => this._competitors.checkNow(org.id, id));
  }

  @Delete('/:id')
  remove(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    requireOrgAdmin(org);
    return wrap(() => this._competitors.remove(org.id, id));
  }
}
