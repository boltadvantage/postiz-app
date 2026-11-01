// Bolt Advantage: hide channel types you don't use from the Add Channel screen.
import { Body, Controller, Get, HttpException, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { requireOrgAdmin } from '@gitroom/nestjs-libraries/user/require.org.admin';
import { ChannelVisibilityRepository } from '@gitroom/nestjs-libraries/database/prisma/channel-visibility/channel-visibility.repository';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';

@ApiTags('Integrations')
@Controller('/channel-visibility')
export class ChannelVisibilityController {
  constructor(
    private _channelVisibility: ChannelVisibilityRepository,
    private _integrationManager: IntegrationManager
  ) {}

  @Get('/')
  hidden(@GetOrgFromRequest() org: Organization) {
    return this._channelVisibility.list(org.id);
  }

  @Put('/')
  async set(
    @GetOrgFromRequest() org: Organization,
    @Body('identifier') identifier: string,
    @Body('hidden') hidden: boolean
  ) {
    requireOrgAdmin(org);
    if (
      typeof identifier !== 'string' ||
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(identifier)
    ) {
      throw new HttpException('Unknown channel', 400);
    }

    if (hidden) {
      await this._channelVisibility.hide(org.id, identifier);
    } else {
      await this._channelVisibility.show(org.id, identifier);
    }
    return this._channelVisibility.list(org.id);
  }
}
