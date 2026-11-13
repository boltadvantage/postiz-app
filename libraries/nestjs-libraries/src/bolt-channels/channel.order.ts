// Bolt Advantage: the order of channels within each client, as the user set it
// in the Calendar channel list. One list per workspace; channels not in it
// keep Postiz's usual order after the ones that are.
import type { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

const key = (organizationId: string) => `channel-order:${organizationId}`;

export async function channelOrder(prisma: PrismaService, organizationId: string): Promise<string[]> {
  const row = await prisma.boltSetting.findUnique({ where: { key: key(organizationId) } });
  try {
    const v = JSON.parse(row?.value || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Saves the order; only this workspace's channels are kept. */
export async function saveChannelOrder(prisma: PrismaService, organizationId: string, ids: unknown) {
  if (!Array.isArray(ids)) throw new Error('ids must be a list');
  const own = new Set(
    (await prisma.integration.findMany({ where: { organizationId, deletedAt: null }, select: { id: true } })).map((i) => i.id)
  );
  const order = [...new Set(ids.map(String))].filter((id) => own.has(id));
  await prisma.boltSetting.upsert({
    where: { key: key(organizationId) },
    create: { key: key(organizationId), value: JSON.stringify(order) },
    update: { value: JSON.stringify(order) },
  });
  return order;
}
