// Bolt Advantage: Canva Connect (REST) client. Postiz opens Canva's editor for
// a new design, the user picks stock photos and designs there, and Canva's
// "return" button brings them back with a signed note saying which design it
// was; Postiz then exports it and keeps the image. Canva's API can't search
// its stock library from outside the editor, so that part always happens in
// Canva itself.
import { constants, createHash, createPublicKey, randomBytes, verify as verifySignature } from 'crypto';

const API = 'https://api.canva.com/rest/v1';
export const CANVA_AUTHORIZE = 'https://www.canva.com/api/oauth/authorize';
export const CANVA_SCOPES = ['design:content:write', 'design:content:read', 'design:meta:read', 'profile:read'];

/** Sizes offered for a new design: the common social shapes. */
export const CANVA_SIZES = {
  square: { width: 1080, height: 1080, label: 'Square 1080×1080' },
  portrait: { width: 1080, height: 1350, label: 'Portrait 1080×1350' },
  story: { width: 1080, height: 1920, label: 'Story 1080×1920' },
  landscape: { width: 1200, height: 675, label: 'Landscape 1200×675' },
} as const;
export type CanvaSize = keyof typeof CANVA_SIZES;

export type CanvaTokens = { access: string; refresh: string; expiresAt: number; name?: string };

export const canvaConfigured = () => !!(process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET);
const backendUrl = () => (process.env.NEXT_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
export const canvaRedirectUri = () => `${backendUrl()}/bolt-canva/callback`;
export const canvaReturnUrl = () => `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/canva-return`;

/** PKCE: the verifier stays with us, Canva gets its SHA-256. */
export function pkce() {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl(state: string, challenge: string) {
  const q = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: 's256',
    scope: CANVA_SCOPES.join(' '),
    response_type: 'code',
    client_id: process.env.CANVA_CLIENT_ID || '',
    state,
    redirect_uri: canvaRedirectUri(),
  });
  return `${CANVA_AUTHORIZE}?${q}`;
}

const apiError = (status: number, body: any, what: string) => {
  const msg = body?.message || body?.error_description || body?.error || body?.code || `HTTP ${status}`;
  return new Error(`Canva (${what}): ${msg}`);
};

/** Code or refresh token → tokens. Canva's refresh tokens work once: the new one must be kept. */
export async function canvaToken(params: Record<string, string>): Promise<CanvaTokens> {
  const basic = Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body?.access_token) throw apiError(res.status, body, 'sign-in');
  return { access: body.access_token, refresh: body.refresh_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
}

export class CanvaApi {
  constructor(private token: string) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(res.status, json, path.split('?')[0]);
    return json;
  }

  async profileName() {
    const r = await this.call('GET', '/users/me/profile').catch(() => null);
    return (r?.profile?.display_name as string) || undefined;
  }

  async createDesign(width: number, height: number, title?: string) {
    const r = await this.call('POST', '/designs', {
      type: 'type_and_asset',
      design_type: { type: 'custom', width, height },
      ...(title ? { title: title.slice(0, 255) } : {}),
    });
    return r.design as CanvaDesign;
  }

  async listDesigns(query?: string, continuation?: string) {
    const q = new URLSearchParams({ limit: '30', sort_by: query ? 'relevance' : 'modified_descending' });
    if (query) q.set('query', query.slice(0, 255));
    if (continuation) q.set('continuation', continuation);
    const r = await this.call('GET', `/designs?${q}`);
    return { items: (r.items || []) as CanvaDesign[], continuation: (r.continuation as string) || null };
  }

  async getDesign(id: string) {
    return (await this.call('GET', `/designs/${encodeURIComponent(id)}`)).design as CanvaDesign;
  }

  /** Export pages as images and wait for the files (Canva does it in the background). */
  async exportDesign(id: string, format: 'jpg' | 'png', pages?: number[]) {
    const fmt: any = format === 'png' ? { type: 'png' } : { type: 'jpg', quality: 92 };
    if (pages?.length) fmt.pages = pages;
    let job = (await this.call('POST', '/exports', { design_id: id, format: fmt })).job;
    const until = Date.now() + 90_000;
    while (job?.status === 'in_progress' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      job = (await this.call('GET', `/exports/${encodeURIComponent(job.id)}`)).job;
    }
    if (job?.status !== 'success') {
      throw new Error(job?.status === 'failed' ? `Canva couldn't export it: ${job?.error?.message || job?.error?.code || 'unknown'}` : 'Canva is taking too long to export; try again');
    }
    return (job.urls || []) as string[];
  }
}

export type CanvaDesign = {
  id: string;
  title?: string;
  urls?: { edit_url?: string; view_url?: string };
  thumbnail?: { url?: string; width?: number; height?: number };
  page_count?: number;
  updated_at?: number;
};

/** The editor link, marked so Canva's return button tells us which request it belongs to. */
export function editLink(editUrl: string, correlationState: string) {
  const u = new URL(editUrl);
  u.searchParams.set('correlation_state', correlationState);
  return u.toString();
}

let keys: { at: number; byKid: Map<string, any> } | null = null;
async function canvaKey(kid: string) {
  if (!keys || Date.now() - keys.at > 3600_000 || !keys.byKid.has(kid)) {
    const res = await fetch(`${API}/connect/keys`, { signal: AbortSignal.timeout(15000) });
    const body: any = await res.json().catch(() => ({}));
    keys = { at: Date.now(), byKid: new Map((body?.keys || []).map((k: any) => [k.kid, k])) };
  }
  const jwk = keys.byKid.get(kid);
  if (!jwk) throw new Error('Canva return link signed with an unknown key');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * How to check each signature type Canva may use. Only public-key types:
 * shared-secret (HS*) and "none" are refused, so a forged note can't pass.
 */
const ALGS: Record<string, { hash: string | null; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true },
  PS384: { hash: 'sha384', pss: true },
  PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true },
  ES384: { hash: 'sha384', ec: true },
  ES512: { hash: 'sha512', ec: true },
  EdDSA: { hash: null },
};

/** Canva's return link → which design, and our note. Signed by Canva for our app only. */
export async function readReturnToken(token: string) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Not a Canva return link');
  let header: any, claims: any;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Not a Canva return link');
  }
  const alg = ALGS[header?.alg];
  if (!alg) throw new Error(`Canva return link uses an unsupported signature (${String(header?.alg).slice(0, 20)})`);
  if (!header?.kid) throw new Error('Not a Canva return link');
  const key = await canvaKey(String(header.kid));
  const ok = verifySignature(
    alg.hash,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    {
      key,
      ...(alg.pss ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : {}),
      ...(alg.ec ? { dsaEncoding: 'ieee-p1363' as const } : {}),
    },
    Buffer.from(parts[2], 'base64url')
  );
  if (!ok) throw new Error('Canva return link signature does not check out');
  const aud = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (!process.env.CANVA_CLIENT_ID || !aud.includes(process.env.CANVA_CLIENT_ID)) throw new Error('Canva return link is for another app');
  if (claims?.exp && Date.now() / 1000 > Number(claims.exp) + 60) throw new Error('Canva return link has expired; use My designs to bring it in');
  if (!claims?.design_id) throw new Error('Canva did not say which design');
  return { designId: String(claims.design_id), state: claims.correlation_state ? String(claims.correlation_state) : null };
}
