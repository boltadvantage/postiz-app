// Bolt Advantage: channel order within each client (Calendar channel list, inbox).
import { Body, Controller, Get, HttpException, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { channelOrder, saveChannelOrder } from '@gitroom/nestjs-libraries/bolt-channels/channel.order';

@ApiTags('Bolt Channels')
@Controller('/bolt-channels')
export class BoltChannelsController {
  constructor(private _prisma: PrismaService) {}

  @Get('/order')
  order(@GetOrgFromRequest() org: Organization) {
    return channelOrder(this._prisma, org.id);
  }

  @Put('/order')
  async save(@GetOrgFromRequest() org: Organization, @Body() body: { ids?: unknown }) {
    try {
      return await saveChannelOrder(this._prisma, org.id, body?.ids);
    } catch (e: any) {
      throw new HttpException(e?.message || 'Bad request', 400);
    }
  }
}
