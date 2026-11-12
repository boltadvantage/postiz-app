import { inboxSwitches, setInboxSwitch, switchChecker } from './switches';

const fakePrisma = () => {
  const rows = new Map<string, string>();
  return {
    rows,
    boltSetting: {
      findUnique: jest.fn(async ({ where }: any) => (rows.has(where.key) ? { value: rows.get(where.key) } : null)),
      upsert: jest.fn(async ({ where, create }: any) => rows.set(where.key, create.value)),
    },
  } as any;
};

describe('inbox switches', () => {
  it('turns one channel’s messages off and back on, per organization', async () => {
    const prisma = fakePrisma();
    expect(await inboxSwitches(prisma, 'o1')).toEqual({ mentions: [], messages: [] });
    await setInboxSwitch(prisma, 'o1', 'nostr1', 'messages', false);
    await setInboxSwitch(prisma, 'o1', 'nostr1', 'messages', false);
    expect(await inboxSwitches(prisma, 'o1')).toEqual({ mentions: [], messages: ['nostr1'] });
    expect(await inboxSwitches(prisma, 'o2')).toEqual({ mentions: [], messages: [] });

    const messagesOff = switchChecker(prisma, 'messages');
    expect(await messagesOff({ id: 'nostr1', organizationId: 'o1' })).toBe(true);
    expect(await messagesOff({ id: 'x1', organizationId: 'o1' })).toBe(false);
    // mentions for the same channel keep coming
    expect(await switchChecker(prisma, 'mentions')({ id: 'nostr1', organizationId: 'o1' })).toBe(false);

    await setInboxSwitch(prisma, 'o1', 'nostr1', 'messages', true);
    expect((await inboxSwitches(prisma, 'o1')).messages).toEqual([]);
  });

  it('ignores a damaged setting', async () => {
    const prisma = fakePrisma();
    prisma.rows.set('inbox-off:o1', 'not json');
    expect(await inboxSwitches(prisma, 'o1')).toEqual({ mentions: [], messages: [] });
  });
});
