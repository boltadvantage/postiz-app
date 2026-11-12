// Bolt Advantage: per-channel inbox switches — stop checking a channel's
// mentions/comments or its direct messages (e.g. a Nostr account getting spam).
// What's already in the inbox stays; nothing new is fetched while it's off.
import type { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export type InboxSwitch = 'mentions' | 'messages';
export type InboxSwitches = Record<InboxSwitch, string[]>;

const key = (organizationId: string) => `inbox-off:${organizationId}`;
const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string'))] : []);

/** The channels whose mentions or messages are switched off. */
export async function inboxSwitches(prisma: PrismaService, organizationId: string): Promise<InboxSwitches> {
  const row = await prisma.boltSetting.findUnique({ where: { key: key(organizationId) } });
  try {
    const v = JSON.parse(row?.value || '{}');
    return { mentions: ids(v.mentions), messages: ids(v.messages) };
  } catch {
    return { mentions: [], messages: [] };
  }
}

export async function setInboxSwitch(prisma: PrismaService, organizationId: string, integrationId: string, what: InboxSwitch, on: boolean) {
  const current = await inboxSwitches(prisma, organizationId);
  const off = new Set(current[what]);
  if (on) off.delete(integrationId);
  else off.add(integrationId);
  const next = { ...current, [what]: [...off] };
  await prisma.boltSetting.upsert({
    where: { key: key(organizationId) },
    create: { key: key(organizationId), value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}

/** For a sync over many organizations: is this channel's `what` switched off? */
export function switchChecker(prisma: PrismaService, what: InboxSwitch) {
  const byOrg = new Map<string, Promise<InboxSwitches>>();
  return async (integration: { id: string; organizationId: string }) => {
    if (!byOrg.has(integration.organizationId)) byOrg.set(integration.organizationId, inboxSwitches(prisma, integration.organizationId));
    return (await byOrg.get(integration.organizationId)!)[what].includes(integration.id);
  };
}
