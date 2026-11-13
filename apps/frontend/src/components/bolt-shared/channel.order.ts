'use client';

// Bolt Advantage: the user's channel order within each client, shared by the
// Calendar channel list and the inbox.
import { useCallback } from 'react';
import useSWR from 'swr';
import { orderBy } from 'lodash';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export const useChannelOrder = () => {
  const fetch = useFetch();
  const { data, mutate } = useSWR<string[]>(
    'bolt-channel-order',
    async () => {
      const res = await fetch('/bolt-channels/order');
      return res.ok ? res.json() : [];
    },
    { revalidateOnFocus: false }
  );
  const save = useCallback(async (ids: string[]) => {
    await mutate(ids, { revalidate: false });
    const res = await fetch('/bolt-channels/order', { method: 'PUT', body: JSON.stringify({ ids }) });
    if (res.ok) await mutate(await res.json(), { revalidate: false });
  }, []);
  return { order: data || [], save };
};

/** Channels in the saved order first, then the rest in Postiz's usual order. */
export function sortByChannelOrder<T extends { id: string; type?: string; disabled?: boolean; identifier?: string }>(list: T[], order: string[]) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return orderBy(list, [(c) => rank.get(c.id) ?? Number.MAX_SAFE_INTEGER, 'type', 'disabled', 'identifier'], ['asc', 'desc', 'asc', 'asc']);
}

/** The whole list's new order after moving one channel up or down within its client. */
export function moveWithin<T extends { id: string }>(groups: T[][], id: string, dir: 'up' | 'down') {
  return groups.flatMap((g) => {
    const i = g.findIndex((c) => c.id === id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= g.length) return g.map((c) => c.id);
    const ids = g.map((c) => c.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return ids;
  });
}
