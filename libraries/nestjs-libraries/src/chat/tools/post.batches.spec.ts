import { postBatches } from './post.batches';

describe('bot posts across channels', () => {
  it('saves channels with the same time and type as one post', () => {
    const batches = postBatches([
      { integrationId: 'x', date: '2026-12-01T15:00:00Z', type: 'schedule' },
      { integrationId: 'fb', date: '2026-12-01T15:00:00.000Z', type: 'schedule' },
      { integrationId: 'li', date: '2026-12-02T15:00:00Z', type: 'schedule' },
      { integrationId: 'nostr', date: '2026-12-01T15:00:00Z', type: 'draft' },
    ]);
    expect(batches.map((b) => b.map((p) => p.integrationId))).toEqual([['x', 'fb'], ['li'], ['nostr']]);
  });
});
