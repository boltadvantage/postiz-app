// Bolt Advantage: save analytics every 6 hours. Each post is only re-read when
// it's due (daily for 30 days, weekly to 90), so most passes do little.
import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { BoltAnalyticsActivity } from '@gitroom/orchestrator/activities/bolt-analytics.activity';

const { syncBoltAnalytics } = proxyActivities<BoltAnalyticsActivity>({
  startToCloseTimeout: '3 hours',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 2,
    backoffCoefficient: 1,
    initialInterval: '10 minutes',
  },
});

export async function boltAnalyticsWorkflow() {
  for (let loops = 0; loops < 28; loops++) {
    try {
      await syncBoltAnalytics();
    } catch (err) {}
    await sleep('6 hours');
  }
  return await continueAsNew<typeof boltAnalyticsWorkflow>();
}
