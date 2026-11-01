import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class ChannelVisibilityRepository {
  constructor(private _hidden: PrismaRepository<'hiddenProvider'>) {}

  async list(organizationId: string) {
    const rows = await this._hidden.model.hiddenProvider.findMany({
      where: { organizationId },
      select: { identifier: true },
    });
    return rows.map((r) => r.identifier);
  }

  hide(organizationId: string, identifier: string) {
    return this._hidden.model.hiddenProvider.upsert({
      where: { organizationId_identifier: { organizationId, identifier } },
      create: { organizationId, identifier },
      update: {},
    });
  }

  show(organizationId: string, identifier: string) {
    return this._hidden.model.hiddenProvider.deleteMany({
      where: { organizationId, identifier },
    });
  }
}
