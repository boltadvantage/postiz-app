// Bolt Advantage: make sure the analytics workflow is running. Unlike upstream's
// cron workflows this isn't gated on RUN_CRON, which self-hosted installs don't set.
import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

@Injectable()
export class BoltAnalyticsRegister implements OnModuleInit {
  constructor(private _temporalService: TemporalService) {}

  async onModuleInit() {
    try {
      await this._temporalService.client?.getRawClient()?.workflow?.start('boltAnalyticsWorkflow', {
        workflowId: 'bolt-analytics',
        taskQueue: 'main',
        workflowIdConflictPolicy: 'USE_EXISTING',
      });
    } catch (err: any) {
      new Logger('BoltAnalytics').warn(`could not start analytics workflow: ${err?.message || err}`);
    }
  }
}

@Global()
@Module({ providers: [BoltAnalyticsRegister] })
export class BoltAnalyticsRegisterModule {}
