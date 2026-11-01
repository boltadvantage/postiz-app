// Bolt Advantage: check the inbox every 10 minutes (X itself is limited to every 30),
// and hourly run the weekly queue-time refresh check.
import { continueAsNew, patched, proxyActivities, sleep } from '@temporalio/workflow';
import { BoltInboxActivity } from '@gitroom/orchestrator/activities/bolt-inbox.activity';

const { syncBoltInbox, adjustBoltQueues } = proxyActivities<BoltInboxActivity>({
  startToCloseTimeout: '20 minutes',
  taskQueue: 'main',
  retry: { maximumAttempts: 1 },
});

export async function boltInboxWorkflow() {
  for (let loops = 0; loops < 144; loops++) {
    try {
      await syncBoltInbox();
    } catch (err) {}
    // every 6th pass = hourly; adjustDue itself only acts Sunday from 5 AM local.
    // patched(): runs started before this step existed replay without it.
    if (patched('bolt-queue-adjust') && loops % 6 === 0) {
      try {
        await adjustBoltQueues();
      } catch (err) {}
    }
    await sleep('10 minutes');
  }
  return await continueAsNew<typeof boltInboxWorkflow>();
}
