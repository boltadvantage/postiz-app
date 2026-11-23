// Bolt Advantage: changing many inbox people at once (tags, mute, note).

const parseTags = (s: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
};
const cleanTags = (tags: unknown) =>
  [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 20);

export type BulkPeopleChange = { addTags?: unknown; removeTags?: unknown; muted?: boolean; note?: string | null; noteMode?: 'append' | 'replace' };

/** What a bulk change does to one person: their other tags stay; a note is added as a new line unless replacing. */
export function personChange(p: { tags: string | null; note: string | null }, body: BulkPeopleChange) {
  const add = cleanTags(body.addTags);
  const drop = new Set(cleanTags(body.removeTags));
  const note = body.note === undefined || body.note === null ? null : String(body.note).trim().slice(0, 1000);
  const data: { tags?: string; muted?: boolean; note?: string | null } = {};
  if (add.length || drop.size) data.tags = JSON.stringify(cleanTags([...parseTags(p.tags).filter((t) => !drop.has(t)), ...add]));
  if (body.muted !== undefined) data.muted = !!body.muted;
  if (body.noteMode === 'replace') data.note = note || null;
  else if (note) data.note = (p.note ? `${p.note}\n${note}` : note).slice(-1000);
  return data;
}

