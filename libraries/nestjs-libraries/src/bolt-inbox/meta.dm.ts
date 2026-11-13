// Bolt Advantage: Facebook Page (Messenger) and Instagram direct messages,
// through the Page's Conversations API. Both use the Page token Postiz holds
// (an Instagram channel stores its linked Page's token). Meta doesn't charge
// for these calls. Meta only lets a Page answer within 24 hours of the
// person's last message.
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';

const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
const CONVERSATIONS = 25;
const MESSAGES_PER_CONVERSATION = 25;
export type MetaPlatform = 'facebook' | 'instagram';
export const META_DM_LIMIT: Record<MetaPlatform, number> = { facebook: 2000, instagram: 1000 };

export type MetaDm = { id: string; peer: string; direction: 'in' | 'out'; text: string; createdAt: Date };

/** The Page token: Instagram channels store "<page token>___<user token>". */
export const pageToken = (token: string) => token.split('___')[0];

const PERMISSION_HINT: Record<MetaPlatform, string> = {
  facebook:
    'Facebook needs message permission. In your Meta app, add pages_messaging and pages_manage_metadata, then reconnect this Page in Postiz.',
  instagram:
    'Instagram needs message permission. In your Meta app, add instagram_manage_messages and pages_manage_metadata, turn on Settings → Messages → Connected tools → "Allow access to messages" in the Instagram app, then reconnect Instagram in Postiz.',
};

const isPermissionError = (e: any) => e && (e.code === 10 || e.code === 200 || e.code === 230 || /permission/i.test(e.message || ''));
const isWindowError = (e: any) => e && (e.error_subcode === 2018278 || e.error_subcode === 2534022 || /outside of allowed window/i.test(e.message || ''));

/** Node's fetch says only "fetch failed" when it can't reach a server; say who and why instead. */
export function unreachable(service: string, err: any) {
  const code = err?.cause?.code || err?.cause?.name || err?.name;
  const why =
    code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'TimeoutError' || code === 'AbortError'
      ? 'timed out'
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
      ? 'address lookup failed'
      : code === 'ECONNRESET' || code === 'UND_ERR_SOCKET'
      ? 'connection dropped'
      : code || 'network error';
  return new Error(`Couldn't reach ${service} (${why}). It'll try again on the next check.`);
}

export class MetaDmError extends Error {
  constructor(message: string, public permission = false) {
    super(message);
  }
}

/** One conversations page → messages newer than `since`, and the people in them. `self` = Page id or Instagram account id. */
export function parseConversations(res: any, self: string, since: Date) {
  const messages: MetaDm[] = [];
  const people = new Map<string, { handle?: string; name?: string }>();
  let newest = since.getTime();
  for (const c of res?.data || []) {
    const updated = Date.parse(c.updated_time);
    if (Number.isFinite(updated)) newest = Math.max(newest, updated);
    const others = (c.participants?.data || []).filter((p: any) => String(p.id) !== self);
    // group threads aren't something a Page can have; skip anything odd
    if (others.length !== 1) continue;
    const peer = String(others[0].id);
    people.set(peer, { name: others[0].name || others[0].username, handle: others[0].username });
    for (const m of c.messages?.data || []) {
      const at = Date.parse(m.created_time);
      if (!Number.isFinite(at) || at <= since.getTime()) continue;
      messages.push({
        id: String(m.id),
        peer,
        direction: String(m.from?.id) === self ? 'out' : 'in',
        text: m.message || '[attachment]',
        createdAt: new Date(at),
      });
    }
  }
  return { messages, people, newest: new Date(newest) };
}

export class MetaDms {
  constructor(private platform: MetaPlatform, private token: string) {}

  private async call(path: string, init?: RequestInit) {
    const url = `${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(pageToken(this.token))}`;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw new MetaDmError(unreachable(this.platform === 'facebook' ? 'Facebook' : 'Instagram', err).message);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) {
      const e = body?.error || {};
      if (isWindowError(e)) {
        throw new MetaDmError(`${this.platform === 'facebook' ? 'Facebook' : 'Instagram'} only lets you reply within 24 hours of their last message.`);
      }
      // keep Meta's own words: "permission" covers several different fixes
      if (isPermissionError(e)) throw new MetaDmError(`${PERMISSION_HINT[this.platform]} (Meta said: ${e.message || `code ${e.code}`})`, true);
      throw new MetaDmError(`${this.platform === 'facebook' ? 'Facebook' : 'Instagram'}: ${e.message || `HTTP ${res.status}`}`);
    }
    return body;
  }

  /** Conversations updated since `since`, with their newest messages, in one request. */
  async since(self: string, since: Date) {
    const fields = `id,updated_time,participants,messages.limit(${MESSAGES_PER_CONVERSATION}){id,message,from,created_time}`;
    const platform = this.platform === 'facebook' ? 'messenger' : 'instagram';
    const res = await this.call(`me/conversations?platform=${platform}&fields=${encodeURIComponent(fields)}&limit=${CONVERSATIONS}`);
    return parseConversations(res, self, since);
  }

  async send(peer: string, text: string) {
    const body = await this.call('me/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: peer }, message: { text }, messaging_type: 'RESPONSE' }),
    });
    return String(body?.message_id || '') || `sent-${Date.now()}`;
  }
}
