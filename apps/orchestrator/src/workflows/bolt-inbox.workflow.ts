// Bolt Advantage: check the inbox every 10 minutes (X itself is limited to every 30).
import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { BoltInboxActivity } from '@gitroom/orchestrator/activities/bolt-inbox.activity';

const { syncBoltInbox } = proxyActivities<BoltInboxActivity>({
  startToCloseTimeout: '20 minutes',
  taskQueue: 'main',
  retry: { maximumAttempts: 1 },
});

export async function boltInboxWorkflow() {
  for (let loops = 0; loops < 144; loops++) {
    try {
      await syncBoltInbox();
    } catch (err) {}
    await sleep('10 minutes');
  }
  return await continueAsNew<typeof boltInboxWorkflow>();
}
