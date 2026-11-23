// Bolt Advantage: grouping a bot's per-channel posts into combined posts.

/** Entries with the same post time and type, in order: each batch is saved as one combined post. */
export const postBatches = <T extends { date: string; type: string }>(posts: T[]): T[][] => {
  const byKey = new Map<string, T[]>();
  for (const p of posts) {
    const at = Date.parse(p.date);
    const key = `${p.type}|${Number.isFinite(at) ? at : p.date}`;
    byKey.set(key, [...(byKey.get(key) || []), p]);
  }
  return [...byKey.values()];
};
