// Bolt Advantage: alert words, set per channel. A comment on that channel containing one is flagged in the
// inbox, and one from a muted person comes through anyway (with a
// notification) so they can be banned. Matching sees through the usual
// disguises: any letter after the first may be a symbol (f**k, f*ck), symbols
// may sit between letters (f.u.c.k), and longer forms count (fucking).
import type { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

const key = (organizationId: string) => `inbox-alert-words:${organizationId}`;
const MAX_WORDS = 100;
const STAND_IN = '[*#@$%!\\-]';
const BETWEEN = '[*._\\-#@$%!]*';

/** Letters and digits only, 2–30 long, lowercase, no repeats. */
export function cleanWords(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  const out = new Set<string>();
  for (const w of list) {
    const word = String(w ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (word.length >= 2 && word.length <= 30) out.add(word);
    if (out.size >= MAX_WORDS) break;
  }
  return [...out].sort();
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

const pattern = (word: string) => {
  const [first, ...rest] = [...word];
  return `(?<![a-z0-9])${first}${rest.map((c) => `${BETWEEN}(?:${c}|${STAND_IN})`).join('')}`;
};

/** text → the alert words it contains (empty when none, or no words are set). */
export function alertMatcher(words: string[]) {
  const tests = words.map((w) => ({ w, re: new RegExp(pattern(w), 'i') }));
  return (text: string | null | undefined): string[] => {
    if (!text || !tests.length) return [];
    return tests.filter((t) => t.re.test(text)).map((t) => t.w);
  };
}
