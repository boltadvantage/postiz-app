// Bolt Advantage: make sure our background workflows are running. Unlike upstream's
// cron workflows these aren't gated on RUN_CRON, which self-hosted installs don't set.
import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

const WORKFLOWS = [
  { type: 'boltAnalyticsWorkflow', id: 'bolt-analytics' },
  { type: 'boltInboxWorkflow', id: 'bolt-inbox' },
];

@Injectable()
export class BoltAnalyticsRegister implements OnModuleInit {
  constructor(private _temporalService: TemporalService) {}

  async onModuleInit() {
    // each on its own, so one failing to start never blocks the other
    for (const w of WORKFLOWS) {
      try {
        await this._temporalService.client?.getRawClient()?.workflow?.start(w.type, {
          workflowId: w.id,
          taskQueue: 'main',
          workflowIdConflictPolicy: 'USE_EXISTING',
        });
      } catch (err: any) {
        new Logger('Bolt').warn(`could not start ${w.id}: ${err?.message || err}`);
      }
    }
  }
}

@Global()
@Module({ providers: [BoltAnalyticsRegister] })
export class BoltAnalyticsRegisterModule {}
