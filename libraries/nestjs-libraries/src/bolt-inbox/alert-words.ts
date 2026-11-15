// Bolt Advantage: alert words, set per channel. A comment on that channel containing one is flagged in the
// inbox, and one from a muted person comes through anyway (with a
// notification) so they can be banned. Matching sees through the usual
// disguises: any letter after the first may be a symbol (f**k, f*ck), symbols
// may sit between letters (f.u.c.k), and longer forms count (fucking).
// A word in quotes ("ass") matches only on its own, not inside assist.
import type { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

const key = (organizationId: string) => `inbox-alert-words:${organizationId}`;
const MAX_WORDS = 100;
const STAND_IN = '[*#@$%!\\-]';
const BETWEEN = '[*._\\-#@$%!]*';

/**
 * Letters and digits only, 2–30 long, lowercase, no repeats; "quoted" means
 * whole word only. Words typed with symbols inside (f**k) are dropped: the
 * plain word already catches them, and the letters behind a symbol are unknown.
 */
export function cleanWords(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  const out = new Set<string>();
  for (const w of list) {
    const raw = String(w ?? '').toLowerCase().trim();
    const whole = /^["\u201c\u201d].*["\u201c\u201d]$/.test(raw) && raw.length > 2;
    // punctuation at the ends goes; inside the word it means a disguise
    const word = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!/^[a-z0-9]{2,30}$/.test(word)) continue;
    out.add(whole ? `"${word}"` : word);
    if (out.size >= MAX_WORDS) break;
  }
  return [...out].sort((a, b) => a.replace(/"/g, '').localeCompare(b.replace(/"/g, '')));
}

/** Each channel has its own list: integration id → words. */
export type AlertWords = Record<string, string[]>;

export async function alertWords(prisma: PrismaService, organizationId: string): Promise<AlertWords> {
  const row = await prisma.boltSetting.findUnique({ where: { key: key(organizationId) } });
  try {
    const v = JSON.parse(row?.value || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).map(([id, w]) => [id, cleanWords(w)]).filter(([, w]) => w.length));
  } catch {
    return {};
  }
}

export async function saveAlertWords(prisma: PrismaService, organizationId: string, integrationId: string, input: unknown) {
  const all = await alertWords(prisma, organizationId);
  const words = cleanWords(input);
  if (words.length) all[integrationId] = words;
  else delete all[integrationId];
  await prisma.boltSetting.upsert({
    where: { key: key(organizationId) },
    create: { key: key(organizationId), value: JSON.stringify(all) },
    update: { value: JSON.stringify(all) },
  });
  return all;
}

const pattern = (entry: string) => {
  const whole = entry.startsWith('"');
  const [first, ...rest] = [...entry.replace(/"/g, '')];
  return `(?<![a-z0-9])${first}${rest.map((c) => `${BETWEEN}(?:${c}|${STAND_IN})`).join('')}${whole ? '(?![a-z0-9])' : ''}`;
};

/** text → the alert words it contains (empty when none, or no words are set). */
export function alertMatcher(words: string[]) {
  const tests = words.map((w) => ({ w, re: new RegExp(pattern(w), 'i') }));
  return (text: string | null | undefined): string[] => {
    if (!text || !tests.length) return [];
    return tests.filter((t) => t.re.test(text)).map((t) => t.w);
  };
}

/**
 * Where the alert words sit in a text, for highlighting: [start, end) pairs,
 * in order, not overlapping. A match runs on to the end of the word, so
 * "fucking" is marked whole, not just "fuck".
 */
export function alertRanges(entries: string[], text: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const entry of entries) {
    if (!/^"?[a-z0-9]{2,30}"?$/.test(entry)) continue;
    const re = new RegExp(`${pattern(entry)}[a-z0-9*#@$%!]*`, 'gi');
    for (const m of text.matchAll(re)) found.push([m.index!, m.index! + m[0].length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of found) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}
