// Bolt Advantage: one inbox sync pass.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { InboxService } from '@gitroom/nestjs-libraries/bolt-inbox/inbox.service';
import { DmService } from '@gitroom/nestjs-libraries/bolt-inbox/dm.service';
import { FollowsService } from '@gitroom/nestjs-libraries/bolt-inbox/follows.service';
import { QueueService } from '@gitroom/nestjs-libraries/bolt-queue/queue.service';

@Injectable()
@Activity()
export class BoltInboxActivity {
  constructor(
    private _inbox: InboxService,
    private _dms: DmService,
    private _follows: FollowsService,
    private _queue: QueueService
  ) {}

  @ActivityMethod()
  async syncBoltInbox() {
    await this._inbox.syncAll();
    await this._dms.syncAll();
    await this._follows.syncAll();
  }

  /** Sunday-morning refresh of queues set to keep their times updated. */
  @ActivityMethod()
  async adjustBoltQueues() {
    await this._queue.adjustDue();
  }
}
