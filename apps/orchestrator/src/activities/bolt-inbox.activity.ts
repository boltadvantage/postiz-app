// Bolt Advantage: one inbox sync pass.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { InboxService } from '@gitroom/nestjs-libraries/bolt-inbox/inbox.service';

@Injectable()
@Activity()
export class BoltInboxActivity {
  constructor(private _inbox: InboxService) {}

  @ActivityMethod()
  async syncBoltInbox() {
    await this._inbox.syncAll();
  }
}
