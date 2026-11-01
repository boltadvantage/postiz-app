// Bolt Advantage: runs one saved-analytics sync pass.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { BoltAnalyticsService } from '@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.service';

@Injectable()
@Activity()
export class BoltAnalyticsActivity {
  constructor(private _boltAnalyticsService: BoltAnalyticsService) {}

  @ActivityMethod()
  async syncBoltAnalytics() {
    await this._boltAnalyticsService.syncAll();
  }
}
