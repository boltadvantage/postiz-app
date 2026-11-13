import { channelOrder, saveChannelOrder } from './channel.order';

describe('channel order', () => {
  it('keeps only this workspace’s channels, once each, in the given order', async () => {
    const rows = new Map<string, string>();
    const prisma: any = {
      integration: { findMany: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      boltSetting: {
        findUnique: async ({ where }: any) => (rows.has(where.key) ? { value: rows.get(where.key) } : null),
        upsert: async ({ where, create }: any) => rows.set(where.key, create.value),
      },
    };
    expect(await channelOrder(prisma, 'o')).toEqual([]);
    expect(await saveChannelOrder(prisma, 'o', ['c', 'x-other-org', 'a', 'c'])).toEqual(['c', 'a']);
    expect(await channelOrder(prisma, 'o')).toEqual(['c', 'a']);
    await expect(saveChannelOrder(prisma, 'o', 'nope')).rejects.toThrow('list');
  });
});
